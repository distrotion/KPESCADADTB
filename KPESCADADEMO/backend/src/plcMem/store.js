// plcMem/store.js — DDL + batch UPSERT + read/diff/groupRuns + snapshot/rollback (T6)
//   pg เท่านั้น (bufferConn/snapshotConn ถูก manager.js validate มาแล้วว่าเป็น pg) · ผ่าน dbManager.query()
//   pattern DDL-on-boot: chartStore.js:73 _ensureTable + _ready cache · ชื่อตาราง sanitize [A-Za-z0-9_] (gotcha #7)
//   snapshot/rollback อาจข้าม connection (bufferConn ≠ snapshotConn ได้ตาม config) — copy ระดับ app
//   ไม่ใช้ INSERT...SELECT ข้าม DB เดียวกันไม่ได้อยู่แล้วเมื่อเป็นคนละ connection/database จริง
const { MAX_ADDR } = require('./constants');

const UPSERT_CHUNK = 100;    // ≤100 row/statement (blueprint §3) — กันยิง statement ยาวเกินไปด้วย
const ROLLBACK_PAGE = 500;   // จำนวน address/หน้าเวลาไล่ rollback เต็มช่วง (cold path — ไม่ต้องเร็วเท่า hot)

// 'YYYYMMDDHHmm' ตามเวลาเครื่อง (local) — ใช้ตั้งชื่อ snap table ต่อครั้ง
function _tsStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

class PlcMemStore {
  constructor(dbManager) {
    this.dbManager = dbManager;
    this._ready = new Set();   // `${conn}:${key}` ที่ ensure ตารางไปแล้ว (idempotent — pattern chartStore._ready)
  }

  // sanitize deviceId ก่อนใช้ต่อชื่อตาราง — deviceId มาจาก user (gotcha #7)
  _safe(id) {
    return String(id || '').replace(/[^A-Za-z0-9_]/g, '') || 'plc';
  }

  _bufTable(plcId, buf) { return `plcmem_buf${buf === 2 ? 2 : 1}_${this._safe(plcId)}`; }

  async _ensureBufTables(conn, plcId) {
    const cacheKey = `${conn}:buf:${this._safe(plcId)}`;
    if (this._ready.has(cacheKey)) return;
    const t1 = this._bufTable(plcId, 1);
    const t2 = this._bufTable(plcId, 2);
    await this.dbManager.query(conn,
      `CREATE TABLE IF NOT EXISTS ${t1} (area varchar(4), addr integer, value integer, updated_at timestamptz, PRIMARY KEY (area, addr))`, []);
    // review finding #1/#4: width (1/2/4) = จำนวนคำต่อเนื่องที่ต้องเขียน/verify พร้อมกันเป็นก้อนเดียว
    //   เสมอ (ตั้งค่าที่ address ฐานเท่านั้น) — ป้องกัน FLOAT32/INT32(=2)/INT64/FLOAT64(=4) ถูกแยกเขียน
    //   คนละ writeBlock/read-back cycle จนค่าขาดครึ่ง (torn value) เมื่อ run ชนขอบ writeMaxWords พอดี
    //   buffer01 ไม่ต้องมี — width เป็นเรื่อง "ความตั้งใจของค่าที่จะเขียน" (buffer02) ไม่ใช่ของ mirror ดิบ
    await this.dbManager.query(conn,
      `CREATE TABLE IF NOT EXISTS ${t2} (area varchar(4), addr integer, value integer, updated_at timestamptz, updated_by varchar(80), width smallint DEFAULT 1, PRIMARY KEY (area, addr))`, []);
    // migrate ตารางเก่าที่เคยสร้างก่อนมี width column (idempotent — เติมคอลัมน์ใหม่เท่านั้น ไม่มีทาง fail)
    try { await this.dbManager.query(conn, `ALTER TABLE ${t2} ADD COLUMN IF NOT EXISTS width smallint DEFAULT 1`, []); } catch (_) {}
    this._ready.add(cacheKey);
  }

  async _ensureJournal(conn) {
    const cacheKey = `${conn}:journal`;
    if (this._ready.has(cacheKey)) return;
    // ⚠️ divergence จาก blueprint §3 (action varchar(16)): ค่าจริงที่ใช้ (write_gate_blocked=19,
    //   buffer2_write_remote=21) ยาวเกิน 16 — เจอจาก plcmem-kpenetwork.test.js ที่เขียนจริงลง pg
    //   (เทส T5 เดิม stub store.journal ไว้เลยไม่เจอ) → กว้างเป็น varchar(32) แทน
    await this.dbManager.query(conn,
      `CREATE TABLE IF NOT EXISTS plcmem_journal (id serial PRIMARY KEY, ts timestamptz, plc varchar(64),
         action varchar(32), detail text, actor varchar(80), actor_type varchar(16), ip varchar(64))`, []);
    // migrate ตารางเก่าที่เคยสร้างด้วย varchar(16) (idempotent — widen เท่านั้น ไม่มีทาง fail)
    try { await this.dbManager.query(conn, `ALTER TABLE plcmem_journal ALTER COLUMN action TYPE varchar(32)`, []); } catch (_) {}
    this._ready.add(cacheKey);
  }

  async journal(conn, { plc, action, detail, actor, actorType, ip } = {}) {
    await this._ensureJournal(conn);
    await this.dbManager.query(conn,
      `INSERT INTO plcmem_journal (ts, plc, action, detail, actor, actor_type, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [new Date(), String(plc || ''), String(action || ''), String(detail || ''), String(actor || ''), String(actorType || ''), String(ip || '')]);
  }

  // ── multi-row UPSERT (batch) — ห้าม insert ทีละแถว (gotcha #2) ──────────────
  //   rows: [{area, addr, value, updatedBy?}] · internally แบ่งเป็นก้อน ≤100 แถว/statement
  async upsertBatch(conn, plcId, buf, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { ok: true, upserted: 0 };
    // review finding #2 (backstop): ห้าม address เกิน 24-bit ผ่านจุดนี้ได้เด็ดขาด ไม่ว่าจะมาจาก
    //   caller ไหน (route/sweeper/rollback/kpenetwork) — mcProtocolDriver ใช้ address field 3 byte
    //   เกินนี้จะ wrap เงียบ ๆ ตอนเขียนจริง (readBlock/writeBlock คำนวณ address เดียวกัน → read-back
    //   verify ผ่านด้วยซ้ำ เพราะทั้งคู่ wrap ไปที่ address เดียวกัน) กลายเป็นเขียนทับ register อื่นแบบไม่มี error
    for (const r of rows) {
      const addr = Number(r.addr);
      if (!Number.isInteger(addr) || addr < 0 || addr > MAX_ADDR) {
        throw new Error(`addr เกินขอบเขตที่ MC 3E รองรับ (0..${MAX_ADDR}): ${r.addr}`);
      }
      // review finding #1/#4 (backstop): width ต้องเป็น 1/2/4 เท่านั้น (จำนวนคำจริงของ INT16/UINT16,
      //   INT32/FLOAT32, INT64/FLOAT64) — ค่าอื่นไม่มีความหมายและอาจทำให้ grouping พัง
      if (buf === 2 && r.width != null && ![1, 2, 4].includes(Number(r.width))) {
        throw new Error(`width ต้องเป็น 1, 2 หรือ 4 เท่านั้น (ได้ ${r.width})`);
      }
    }
    await this._ensureBufTables(conn, plcId);
    const table = this._bufTable(plcId, buf);
    const now = new Date();
    let upserted = 0;
    for (let off = 0; off < rows.length; off += UPSERT_CHUNK) {
      const chunk = rows.slice(off, off + UPSERT_CHUNK);
      const values = [];
      const params = [];
      let i = 1;
      if (buf === 2) {
        for (const r of chunk) {
          values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(String(r.area).toUpperCase(), Number(r.addr), Number(r.value), now, String(r.updatedBy || ''), Number(r.width) || 1);
        }
        const sql = `INSERT INTO ${table} (area, addr, value, updated_at, updated_by, width) VALUES ${values.join(',')}
          ON CONFLICT (area, addr) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, width = EXCLUDED.width`;
        await this.dbManager.query(conn, sql, params);
      } else {
        for (const r of chunk) {
          values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(String(r.area).toUpperCase(), Number(r.addr), Number(r.value), now);
        }
        const sql = `INSERT INTO ${table} (area, addr, value, updated_at) VALUES ${values.join(',')}
          ON CONFLICT (area, addr) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
        await this.dbManager.query(conn, sql, params);
      }
      upserted += chunk.length;
    }
    return { ok: true, upserted };
  }

  // อ่าน buffer แบ่งหน้า (cap 5000 — บังคับที่ route ชั้น T4 อีกที แต่ store เองก็ cap ไว้กันเรียกตรง)
  async readRange(conn, plcId, buf, area, from, to, opts = {}) {
    await this._ensureBufTables(conn, plcId);
    const table = this._bufTable(plcId, buf);
    const limit = Math.min(Math.max(Number(opts.limit) || 1000, 1), 5000);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const params = [String(area).toUpperCase()];
    let where = `area = $1`;
    if (from != null) { params.push(Number(from)); where += ` AND addr >= $${params.length}`; }
    if (to != null) { params.push(Number(to)); where += ` AND addr < $${params.length}`; }
    if (opts.nonzero) where += ` AND value <> 0`;
    params.push(limit); const limIdx = params.length;
    params.push(offset); const offIdx = params.length;
    const cols = buf === 2 ? 'area, addr, value, updated_at, updated_by, width' : 'area, addr, value, updated_at';
    const sql = `SELECT ${cols} FROM ${table} WHERE ${where} ORDER BY addr ASC LIMIT $${limIdx} OFFSET $${offIdx}`;
    return await this.dbManager.query(conn, sql, params);
  }

  // ต่างระหว่าง buf2 (อยากได้) ↔ buf1 (ล่าสุดจริง) — FULL OUTER JOIN กันเคส address มีฝั่งเดียว
  //   review finding #1/#4: ต่างจาก addr เดี่ยว ๆ ธรรมดา — ถ้า address ฐานของกลุ่ม multi-word (width>1)
  //   ต่างไปจาก buf1 ต้องดึงคำต่อเนื่องของกลุ่มนั้นมาด้วยเสมอ แม้บางคำในกลุ่มจะบังเอิญ buf1==buf2
  //   (ไม่งั้น groupRuns จะเห็นแค่บาง word ของกลุ่ม แล้วเขียนแยกจากกันได้ — ค่า torn เหมือนเดิม)
  // ⚠️ ต้องเริ่มจาก buf2 เท่านั้น (ไม่ FULL OUTER JOIN จาก buf1) — address ที่ยังไม่เคยถูกแก้ใน buf2
  //   (ไม่มีแถวเลย) ต้องไม่โผล่ใน diff เด็ดขาด ต่อให้ buf1 ไม่เป็น 0 ก็ตาม เพราะ "0" ใน PLC นี้มีความหมายจริง
  //   (ไม่ใช่ค่า default ที่ไม่มีนัย) — ถ้า treat buf2 ที่ไม่มีแถวเป็น 0 จะกลายเป็นเสนอเขียน 0 ทับทุก address
  //   ที่ยังไม่ได้ตั้งใจแก้เลย (เขียนพัง production ได้จริง) ต้องเห็นเฉพาะ address ที่ผู้ใช้/rollback
  //   ตั้งใจ stage ไว้ใน buf2 จริง ๆ เท่านั้น
  async diff(conn, plcId) {
    await this._ensureBufTables(conn, plcId);
    const t1 = this._bufTable(plcId, 1), t2 = this._bufTable(plcId, 2);
    const sql = `
      SELECT b.area AS area, b.addr AS addr,
             COALESCE(a.value, 0) AS buf1, b.value AS buf2, COALESCE(b.width, 1) AS width
      FROM ${t2} b
      LEFT JOIN ${t1} a ON a.area = b.area AND a.addr = b.addr
      WHERE COALESCE(a.value, 0) <> b.value
      ORDER BY area, addr`;
    const rows = (await this.dbManager.query(conn, sql, [])).map((r) => ({
      area: r.area, addr: Number(r.addr), buf1: Number(r.buf1), buf2: Number(r.buf2), width: Number(r.width) || 1,
    }));
    return this._expandGroups(conn, plcId, rows);
  }

  // เติมคำต่อเนื่องของกลุ่ม multi-word ที่ยังไม่อยู่ใน diff (เพราะบังเอิญ buf1==buf2 สำหรับคำนั้น)
  //   ให้ครบตาม width ของ address ฐาน — จำเป็นเพื่อไม่ให้ groupRuns เห็นกลุ่มไม่ครบแล้วแยก run
  async _expandGroups(conn, plcId, rows) {
    const bases = rows.filter((r) => r.width > 1);
    if (!bases.length) return rows;
    const have = new Set(rows.map((r) => `${r.area}:${r.addr}`));
    const t1 = this._bufTable(plcId, 1), t2 = this._bufTable(plcId, 2);
    for (const base of bases) {
      for (let k = 1; k < base.width; k++) {
        const key = `${base.area}:${base.addr + k}`;
        if (have.has(key)) continue;
        have.add(key);
        const [b1, b2] = await Promise.all([
          this.dbManager.query(conn, `SELECT value FROM ${t1} WHERE area = $1 AND addr = $2`, [base.area, base.addr + k]),
          this.dbManager.query(conn, `SELECT value, width FROM ${t2} WHERE area = $1 AND addr = $2`, [base.area, base.addr + k]),
        ]);
        rows.push({
          area: base.area, addr: base.addr + k,
          buf1: b1[0] ? Number(b1[0].value) : 0,
          buf2: b2[0] ? Number(b2[0].value) : 0,
          width: b2[0] ? (Number(b2[0].width) || 1) : 1,
        });
      }
    }
    rows.sort((a, b) => (a.area === b.area ? a.addr - b.addr : (a.area < b.area ? -1 : 1)));
    return rows;
  }

  // จับกลุ่ม diff ที่ addr ต่อเนื่องกัน (same area, addr+1) เป็น run ≤ maxWords — ห้ามรวมข้าม area/ช่องว่าง
  //   review finding #1/#4: ก่อนจับ run ต้องจับ "หน่วยอะตอม" ก่อน — address ฐานที่มี width>1 (มาจาก
  //   PUT buffer2 ที่ตั้ง width ไว้ตอนเขียนค่า multi-word) ต้องลากคำต่อเนื่อง (width-1) ตัวติดไปด้วยเสมอ
  //   ห้ามให้ขอบ run (maxWords) มาตัดกลางหน่วยอะตอมเด็ดขาด — ถ้าหน่วยอะตอมยาวกว่า maxWords เอง (เช่น
  //   width=4 แต่ maxWords=2) ยอมให้ run นั้นยาวเกิน maxWords ไปเลย (ความถูกต้อง/ความปลอดภัยมาก่อนเพดาน)
  groupRuns(diffRows, maxWords) {
    const max = Math.max(1, Number(maxWords) || 100);
    const byArea = new Map();
    for (const r of diffRows || []) {
      if (!byArea.has(r.area)) byArea.set(r.area, []);
      byArea.get(r.area).push(r);
    }
    const runs = [];
    for (const [area, rowsRaw] of byArea) {
      const rows = [...rowsRaw].sort((a, b) => a.addr - b.addr);
      const units = [];
      let i = 0;
      while (i < rows.length) {
        const r = rows[i];
        const width = Math.max(1, Number(r.width) || 1);
        const words = [r.buf2];
        let complete = true;
        for (let k = 1; k < width; k++) {
          const next = rows[i + k];
          if (!next || next.addr !== r.addr + k) { complete = false; break; }
          words.push(next.buf2);
        }
        if (complete && width > 1) {
          units.push({ area, start: r.addr, words });
          i += width;
        } else {
          // width>1 แต่หาคำต่อเนื่องไม่ครบ (ข้อมูลไม่สมบูรณ์ผิดปกติ) → fallback เป็นคำเดี่ยว กันพัง
          units.push({ area, start: r.addr, words: [r.buf2] });
          i += 1;
        }
      }
      let cur = null;
      for (const u of units) {
        if (cur && u.start === cur.start + cur.words.length && cur.words.length + u.words.length <= max) {
          cur.words.push(...u.words);
        } else {
          if (cur) runs.push(cur);
          cur = { area, start: u.start, words: [...u.words] };
        }
      }
      if (cur) runs.push(cur);
    }
    return runs;
  }

  // ── T6: snapshot (cold path) — สารบัญกลาง plcmem_snapshots ที่ snapshotConn ──────────
  _snapTable(plcId, ts) { return `plcmem_snap_${this._safe(plcId)}_${ts}`; }

  async _ensureSnapshotCatalog(conn) {
    const cacheKey = `${conn}:snapcat`;
    if (this._ready.has(cacheKey)) return;
    await this.dbManager.query(conn,
      `CREATE TABLE IF NOT EXISTS plcmem_snapshots (id serial PRIMARY KEY, snap_table varchar(128), plc varchar(64),
         ranges text, count integer, note text, created_at timestamptz, created_by varchar(80))`, []);
    this._ready.add(cacheKey);
  }

  // backup: อ่าน buffer01 (bufferConn) "ทุก address ที่เคยกวาดแล้ว" (ไม่กรอง non-zero) → เขียนลง snap
  //   table ใหม่ (snapshotConn) + ลงสารบัญ — เดิมกรองเฉพาะ non-zero เพราะคิดว่า 0 = default ไม่มีนัย
  //   แต่ PLC นี้ 0 มีความหมายจริง (เช่น setpoint/flag ที่ตั้งใจให้เป็น 0) กรองทิ้งแล้ว rollback จะไม่คืนค่า
  //   0 ที่ถูกต้องกลับมา (เข้าใจผิดว่า "ไม่เคยกวาด" แทน) ต้องเก็บทุกแถวที่มีจริงใน buffer01 เท่านั้น
  async backup(bufferConn, snapshotConn, plcId, ranges, note, actor) {
    await this._ensureBufTables(bufferConn, plcId);
    await this._ensureSnapshotCatalog(snapshotConn);
    const now = new Date();
    const snapTable = this._snapTable(plcId, _tsStamp(now));
    await this.dbManager.query(snapshotConn,
      `CREATE TABLE IF NOT EXISTS ${snapTable} (area varchar(4), addr integer, value integer, PRIMARY KEY (area, addr))`, []);

    let count = 0;
    for (const r of ranges || []) {
      let offset = 0;
      for (;;) {
        const rows = await this.readRange(bufferConn, plcId, 1, r.area, r.start, r.end, { limit: 5000, offset });
        if (!rows.length) break;
        for (let off = 0; off < rows.length; off += UPSERT_CHUNK) {
          const chunk = rows.slice(off, off + UPSERT_CHUNK);
          const values = []; const params = []; let i = 1;
          for (const row of chunk) {
            values.push(`($${i++}, $${i++}, $${i++})`);
            params.push(String(row.area).toUpperCase(), Number(row.addr), Number(row.value));
          }
          await this.dbManager.query(snapshotConn,
            `INSERT INTO ${snapTable} (area, addr, value) VALUES ${values.join(',')} ON CONFLICT (area, addr) DO NOTHING`, params);
        }
        count += rows.length;
        offset += rows.length;
        if (rows.length < 5000) break;   // หน้าสุดท้าย
      }
    }

    const ins = await this.dbManager.query(snapshotConn,
      `INSERT INTO plcmem_snapshots (snap_table, plc, ranges, count, note, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [snapTable, plcId, JSON.stringify(ranges || []), count, String(note || ''), now, String(actor || '')]);
    return { id: ins[0] && ins[0].id, snapTable, count, createdAt: now };
  }

  async listSnapshots(snapshotConn, plcId) {
    await this._ensureSnapshotCatalog(snapshotConn);
    const rows = await this.dbManager.query(snapshotConn,
      `SELECT id, snap_table, plc, ranges, count, note, created_at, created_by
         FROM plcmem_snapshots WHERE plc = $1 ORDER BY id DESC`, [plcId]);
    return rows.map((r) => ({
      id: r.id, snapTable: r.snap_table, plc: r.plc, ranges: JSON.parse(r.ranges || '[]'),
      count: r.count, note: r.note, createdAt: r.created_at, createdBy: r.created_by,
    }));
  }

  // rollback: เท snapshot เข้า buffer02 (bufferConn) — ไม่แตะ PLC เด็ดขาด (write จริงเป็นหน้าที่ T5/user)
  //   ไล่เต็มช่วง ranges ที่บันทึกไว้ตอน backup ทีละหน้า (ROLLBACK_PAGE) — address ที่ไม่อยู่ใน snap = 0
  async rollback(bufferConn, snapshotConn, plcId, snapId, actor) {
    await this._ensureSnapshotCatalog(snapshotConn);
    const cat = await this.dbManager.query(snapshotConn,
      `SELECT snap_table, ranges FROM plcmem_snapshots WHERE id = $1 AND plc = $2`, [Number(snapId), plcId]);
    if (!cat.length) throw new Error(`snapshot id ${snapId} ไม่พบ (plc ${plcId})`);
    const snapTable = cat[0].snap_table;
    const ranges = JSON.parse(cat[0].ranges || '[]');
    await this._ensureBufTables(bufferConn, plcId);

    let restored = 0;
    for (const r of ranges) {
      for (let pos = r.start; pos < r.end; pos += ROLLBACK_PAGE) {
        const hi = Math.min(pos + ROLLBACK_PAGE, r.end);
        const snapRows = await this.dbManager.query(snapshotConn,
          `SELECT addr, value FROM ${snapTable} WHERE area = $1 AND addr >= $2 AND addr < $3`, [r.area, pos, hi]);
        const byAddr = new Map(snapRows.map((row) => [Number(row.addr), Number(row.value)]));
        const rows = [];
        for (let a = pos; a < hi; a++) rows.push({ area: r.area, addr: a, value: byAddr.get(a) || 0, updatedBy: actor });
        await this.upsertBatch(bufferConn, plcId, 2, rows);
        restored += rows.length;
      }
    }
    return { ok: true, restored, snapTable, ranges };
  }

  // deleteSnapshot: DROP snap table + ลบแถวสารบัญ — คืน {ok:false} ถ้าไม่พบที่ conn นี้ (ไม่ throw
  //   เพราะ manager.js ต้องลองหลาย snapshotConn ถ้าหลาย plc ใช้คนละ connection กัน — ดู manager.deleteSnapshot)
  //   คืน plc มาด้วย (จาก catalog row ก่อนลบ) — ให้ manager.js journal เข้า bufferConn ของ plc นั้นได้ถูกตัว
  async deleteSnapshot(snapshotConn, snapId) {
    await this._ensureSnapshotCatalog(snapshotConn);
    const rows = await this.dbManager.query(snapshotConn, `SELECT snap_table, plc FROM plcmem_snapshots WHERE id = $1`, [Number(snapId)]);
    if (!rows.length) return { ok: false, error: 'not found' };
    const snapTable = rows[0].snap_table;
    const plc = rows[0].plc;
    await this.dbManager.query(snapshotConn, `DROP TABLE IF EXISTS ${snapTable}`, []);
    await this.dbManager.query(snapshotConn, `DELETE FROM plcmem_snapshots WHERE id = $1`, [Number(snapId)]);
    return { ok: true, snapTable, plc };
  }
}

module.exports = PlcMemStore;
