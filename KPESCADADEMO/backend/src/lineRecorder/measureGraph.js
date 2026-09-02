// measureGraph.js — auto Query Buffer สำหรับกราฟ "ค่าที่คนวัดเอง" (measure)
//   1 measure field = 1 buffer · แถว = 1 งาน (N งานล่าสุด) · 1 คอลัมน์ค่าต่อ field → chart xy
//     x = ฟิวของงาน (barcode/carrier ตามที่ตั้ง) · y = <key> (ค่าของงาน ไม่แยกบ่อแล้ว)
//   ค่าที่วัดผูกกับ "งาน" ไม่ใช่บ่อ — แถวเก่าที่ยังมี station ติดมาก็นับรวมเส้นเดียวกัน
//   ผูกกับ DB เดียวกับ store ของไลน์ (source.storeDb) — ตาราง lr_<line>_job + lr_<line>_measure

// ต้องตรงกับ lineStore/sqlStore.js `_sid()` เป๊ะ ๆ (ชื่อตารางเดียวกัน) — แทนอักขระพิเศษด้วย _ ไม่ใช่ลบทิ้ง
//   PH-LINE → ph_line → lr_ph_line_job / lr_ph_line_measure
const sid = (line) => String(line).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

// ชื่อ buffer ต้อง deterministic → upsert ได้ (ไม่งั้น save ไลน์ทีเดียวได้ buffer ซ้ำ)
function bufferName(line, key) { return `measure: ${line} · ${key}`; }

// คอลัมน์ที่ chart จะใช้เป็นแกน X — ฟิวของงาน (job scope) ที่ตั้งไว้ · fallback = carrier
function xColumnOf(cfg) {
  const want = String(((cfg.measure || {}).graphX) || '').trim();
  const jobKeys = (cfg.fields || []).filter((f) => f.scope === 'job').map((f) => f.key);
  if (want && (want === 'carrier' || jobKeys.includes(want))) return want;
  return jobKeys.includes('barcode') ? 'barcode' : 'carrier';
}

// ── ค่าที่เป็นตัวแทนเมื่อมีหลายค่าตกอยู่ที่จุดเดียวกัน ────────────────────────
//   ซ้ำได้ 2 ระดับ: (1) งานเดียว วัดซ้ำหลายครั้ง  (2) X เดียวกันหลายชิ้นงาน (order เดียวกัน)
//   ทั้งสองระดับใช้กติกาเดียวกัน (graphAgg) — ต้องเป็น SQL มาตรฐาน ใช้ได้ทั้ง pg/mysql/sqlite/mssql
const AGGS = ['last', 'avg', 'max', 'min'];
function aggOf(cfg) {
  const a = String(((cfg.measure || {}).graphAgg) || '').trim();
  return AGGS.includes(a) ? a : 'last';
}

// SQL expression ที่ยุบทุกใบวัดของ field นี้เหลือค่าเดียว (ไม่แยกบ่อ)
//   last อาศัย subquery x (เวลาล่าสุดของกลุ่ม) ที่ join ไว้ให้แล้ว — ตัวอื่นไม่ต้องใช้
function valueExpr(agg) {
  if (agg === 'avg') return 'AVG(m.value)';
  if (agg === 'max') return 'MAX(m.value)';
  if (agg === 'min') return 'MIN(m.value)';
  return 'MAX(CASE WHEN m.ts = x.mts THEN m.value END)';   // last (default)
}

// ยุบชิ้นงานที่ X ซ้ำกันให้เหลือจุดเดียวหรือไม่
//   X = ฟิวของงาน (barcode/order/lot) → order เดียวกันหลายชิ้น = 1 จุด (ตามกติกา agg)
//   X = carrier → แคร่ถูกใช้ซ้ำทุกงาน ถ้ายุบจะเหลือจุดเดียวทั้งประวัติ → ไม่ยุบ (1 จุด = 1 งาน)
function mergeSameX(cfg) { return xColumnOf(cfg) !== 'carrier'; }

// อ่านฟิวของงานจาก header (jsonb/text) — syntax ต่างกันตาม dialect
function headerExpr(dialect, key, alias = 'j') {
  if (dialect === 'mssql') return `JSON_VALUE(${alias}.header, '$.${key}')`;
  if (dialect === 'mysql') return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.header, '$.${key}'))`;
  if (dialect === 'sqlite') return `json_extract(${alias}.header, '$.${key}')`;
  return `${alias}.header->>'${key}'`;   // pg (default)
}

// จำกัดจำนวนแถว — mssql ใช้ TOP แทน LIMIT
function limitClause(dialect, n) { return dialect === 'mssql' ? '' : ` LIMIT ${n}`; }
function topClause(dialect, n) { return dialect === 'mssql' ? `TOP ${n} ` : ''; }

// ชื่อคอลัมน์ค่าที่วัด = key ของ field · แต่ต้องไม่ชนคอลัมน์ประจำที่ SELECT เดียวกันส่งออกอยู่แล้ว
//   (carrier / enter_at / last_measure_ts / คอลัมน์แกน X) — ชนแล้วค่าจะทับกันเงียบ ๆ
//   เช่น field key = 'carrier' → คอลัมน์ carrier กลายเป็นค่าที่วัด เลขแคร่จริงหาย · X=carrier ยิ่งกลายเป็นพล็อตค่ากับตัวเอง
//   ชน = เติมท้าย _val (deterministic → buildSql กับ yCols ต้องใช้ฟังก์ชันนี้ตัวเดียวกันเสมอ)
const RESERVED_COLS = ['carrier', 'enter_at', 'last_measure_ts'];
function valueColName(cfg, field) {
  const key = String(field.key);
  return (RESERVED_COLS.includes(key) || key === xColumnOf(cfg)) ? `${key}_val` : key;
}

// SQL: N งานล่าสุด (เรียงเวลา) + ค่าที่วัด 1 คอลัมน์ (ชื่อ = key ของ field · ชนคอลัมน์ประจำ = <key>_val)
//   ยุบด้วย MAX/AVG(…) = มาตรฐาน SQL ใช้ได้ทุก dialect (FILTER/window ใช้ไม่ได้บน mysql/mssql)
//   นับทุกใบวัดของ (งาน, key) ไม่สนใจ station — ใบเก่ามี ใบใหม่ไม่มี ต้องอยู่เส้นเดียวกัน
//   agg=last: join subquery x = เวลาล่าสุดของ "กลุ่ม" → เลือกแถวตัวแทน
//     กลุ่ม = job_key (ไม่ยุบ) หรือ X (ยุบ order เดียวกัน) — ต้องตรงกับ GROUP BY ข้างนอก
//     ไม่งั้นค่าล่าสุดข้ามชิ้นงานจะเพี้ยน (MAX ของ "ค่า" ไม่ใช่ของ "เวลา")
function buildSql(cfg, field, { limit, dialect = 'pg' } = {}) {
  const line = cfg.line;
  const jt = `lr_${sid(line)}_job`, mt = `lr_${sid(line)}_measure`;
  const key = field.key;
  const n = Number(limit) || Number((cfg.measure || {}).graphJobs) || 200;   // ไม่ส่งมา = เอาจาก config (กัน limit หลุดคนละค่า)
  const xcol = xColumnOf(cfg);
  const xSel = xcol === 'carrier' ? 'j.carrier' : headerExpr(dialect, xcol);
  const agg = aggOf(cfg);
  const merge = mergeSameX(cfg);
  const q = dialect === 'mysql' ? '`' : '"';                       // quote ชื่อคอลัมน์
  const valCol = `  ${valueExpr(agg)} AS ${q}${valueColName(cfg, field)}${q}`;   // 1 เส้น = 1 field
  // N งานล่าสุด — ใช้ทั้งใน FROM และใน subquery x (ตอนยุบ) จึงทำเป็นตัวสร้างซ้ำได้
  //   ตัดงานที่ไม่มีค่าในแกน X ทิ้ง: วาดไม่ได้ (ไม่มีป้าย) และถ้าเป็น NULL การ join แบบ x.gx = X จะไม่ match
  //   (NULL = NULL เป็น false ใน SQL) → ค่าทั้งกลุ่มหายเงียบ ๆ
  const xFilter = xcol === 'carrier' ? ''
    : `\n        AND ${headerExpr(dialect, xcol, 'jj')} IS NOT NULL AND ${headerExpr(dialect, xcol, 'jj')} <> ''`;
  const jobSub = (alias) => [
    `(SELECT ${topClause(dialect, n)}job_key, carrier, header, enter_at FROM ${jt} jj`,
    `      WHERE COALESCE(enter_at, updated_at, 0) > 0${xFilter}`,
    `      ORDER BY COALESCE(enter_at, updated_at, 0) DESC${limitClause(dialect, n)}) ${alias}`,
  ].join('\n');
  const sql = [
    `SELECT ${xSel} AS ${q}${xcol}${q},`,
    merge ? `  MAX(j.carrier) AS carrier, MAX(j.enter_at) AS enter_at,` : `  j.carrier, j.enter_at,`,
    valCol + ',',
    `  MAX(m.ts) AS last_measure_ts`,
    `FROM ${jobSub('j')}`,
    `LEFT JOIN ${mt} m ON m.job_key = j.job_key AND m.key = '${key}'`,
  ];
  if (agg === 'last') {
    sql.push(merge
      // ยุบ: เวลาล่าสุดต่อ X — ต้อง join job เพื่ออ่าน X และจำกัดชุดงานให้เท่ากับข้างนอก
      ? [`LEFT JOIN (SELECT ${headerExpr(dialect, xcol, 'j2')} AS gx, MAX(m2.ts) AS mts`,
         `           FROM ${jobSub('j2')}`,
         `           JOIN ${mt} m2 ON m2.job_key = j2.job_key AND m2.key = '${key}'`,
         `           GROUP BY ${headerExpr(dialect, xcol, 'j2')}) x`,
         `       ON x.gx = ${xSel}`].join('\n')
      // ไม่ยุบ: เวลาล่าสุดต่องาน
      : [`LEFT JOIN (SELECT job_key AS gx, MAX(ts) AS mts FROM ${mt} WHERE key = '${key}'`,
         `           GROUP BY job_key) x ON x.gx = m.job_key`].join('\n'));
  }
  sql.push(
    merge ? `GROUP BY ${xSel}` : `GROUP BY ${xSel}, j.carrier, j.enter_at`,
    merge ? `ORDER BY MAX(j.enter_at) ASC` : `ORDER BY j.enter_at ASC`,
  );
  return sql.join('\n');
}

const AGG_LABEL = { last: 'ค่าล่าสุด', avg: 'ค่าเฉลี่ย', max: 'ค่าสูงสุด', min: 'ค่าต่ำสุด' };

// def ของ buffer 1 ตัว (ยังไม่เขียนลงดิสก์)
function bufferDef(cfg, field, { limit = 200, dialect = 'pg' } = {}) {
  const agg = aggOf(cfg);
  return {
    name: bufferName(cfg.line, field.key),
    kind: 'sql',
    dbConn: String((cfg.source || {}).storeDb || ''),
    sql: buildSql(cfg, field, { limit, dialect }),
    intervalSec: 60,
    maxRows: Number(limit) || 200,
    filterSummary: `ค่าที่วัด: ${field.label || field.key} · ${cfg.line} · ${limit} งานล่าสุด · ค่าซ้ำ=${AGG_LABEL[agg]}`,
  };
}

// สร้าง/อัปเดต buffer ให้ครบทุก measure field ของไลน์ (idempotent — ยึดชื่อ deterministic)
//   คืน [{ key, bufferId, xCol, yCols }] ให้ UI เอาไปตั้ง chart ได้เลย (yCols = 1 เส้นต่อ field)
function syncBuffers(cfg, qbm, { dialect = 'pg' } = {}) {
  if (!cfg || !qbm) return [];
  const conn = String((cfg.source || {}).storeDb || '');
  const fields = (cfg.fields || []).filter((f) => f.scope === 'measure');
  if (!fields.length || !conn || conn === 'file' || conn === '__test__') return [];   // file store = ไม่มี SQL ให้ query
  const limit = Math.max(1, Math.min(Number((cfg.measure || {}).graphJobs) || 200, 5000));
  const out = [];
  for (const f of fields) {
    const def = bufferDef(cfg, f, { limit, dialect });
    const exist = qbm.list().find((b) => b.name === def.name);
    let rec;
    try { rec = exist ? qbm.update(exist.id, def) : qbm.create(def); }
    catch (e) { console.error('[measureGraph] buffer', def.name, e.message); continue; }
    out.push({
      key: f.key, label: f.label || f.key, bufferId: rec.id,
      xCol: xColumnOf(cfg),
      yCols: [valueColName(cfg, f)],
      agg: aggOf(cfg), aggLabel: AGG_LABEL[aggOf(cfg)], merge: mergeSameX(cfg),
    });
  }
  return out;
}

module.exports = {
  syncBuffers, bufferDef, buildSql, bufferName, xColumnOf, valueColName,
  valueExpr, aggOf, mergeSameX, AGG_LABEL,
};
