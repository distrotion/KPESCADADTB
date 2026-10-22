/**
 * logSchemas — นิยาม schema กลางของตาราง log ทุกชนิด + ตัวสร้าง CREATE TABLE DDL
 *   ใช้สำหรับหน้า Help/อ้างอิงใน Scripts (GET /api/help/log-schemas)
 *
 * ⚠️ ต้องตรงกับที่ engine auto-create จริงใน `_ensureTable`:
 *     alarm_events   → alarmEngine.js
 *     device_log     → deviceLogger.js
 *     chart_history  → chartStore.js
 *     activity_log   → activityLog.js
 *   ถ้าแก้ schema ใน engine ตัวไหน ต้องแก้ที่นี่ด้วย (TODO: ให้ engine import ตัวนี้เป็น source เดียว)
 *
 *   แต่ละคอลัมน์: [name, pgType, mssqlType]  (id + PK เติมให้อัตโนมัติ)
 */
const TABLES = {
  alarm_events: {
    desc: 'Alarm history (ISA-18.2) — 1 แถวต่อ 1 event (raised/acked/cleared/normal/shelved)',
    cols: [
      ['ts',         'TIMESTAMP',         'DATETIME'],
      ['event',      'VARCHAR(16)',       'VARCHAR(16)'],
      ['alarm_id',   'VARCHAR(64)',       'VARCHAR(64)'],
      ['name',       'VARCHAR(200)',      'NVARCHAR(200)'],
      ['type',       'VARCHAR(16)',       'VARCHAR(16)'],
      ['sub_type',   'VARCHAR(16)',       'VARCHAR(16)'],
      ['device_id',  'VARCHAR(64)',       'VARCHAR(64)'],
      ['tag_id',     'VARCHAR(64)',       'VARCHAR(64)'],
      ['priority',   'VARCHAR(16)',       'VARCHAR(16)'],
      ['group_name', 'VARCHAR(64)',       'NVARCHAR(64)'],
      ['state',      'VARCHAR(16)',       'VARCHAR(16)'],
      ['val',        'DOUBLE PRECISION',  'FLOAT'],
      ['setpoint',   'DOUBLE PRECISION',  'FLOAT'],
      ['message',    'VARCHAR(400)',      'NVARCHAR(400)'],
      ['ack_by',     'VARCHAR(64)',       'VARCHAR(64)'],
      ['comment',    'VARCHAR(400)',      'NVARCHAR(400)'],
    ],
  },
  device_log: {
    desc: 'Device connection log (online/offline)',
    cols: [
      ['ts',        'TIMESTAMP',    'DATETIME'],
      ['device_id', 'VARCHAR(64)',  'VARCHAR(64)'],
      ['name',      'VARCHAR(200)', 'NVARCHAR(200)'],
      ['event',     'VARCHAR(24)',  'VARCHAR(24)'],
      ['detail',    'VARCHAR(400)', 'NVARCHAR(400)'],
    ],
  },
  chart_history: {
    desc: 'Chart/trend history (ค่า tag ตามเวลา สำหรับ widget Chart)',
    cols: [
      ['ts',     'TIMESTAMP',        'DATETIME'],
      ['device', 'VARCHAR(64)',      'VARCHAR(64)'],
      ['tag',    'VARCHAR(64)',      'VARCHAR(64)'],
      ['value',  'DOUBLE PRECISION', 'FLOAT'],
    ],
  },
  activity_log: {
    desc: 'Activity/audit log (login/logout, deploy, tag write, config) — user เป็น reserved word ต้อง quote',
    cols: [
      ['ts',       'TIMESTAMP',    'DATETIME'],
      ['category', 'VARCHAR(24)',  'VARCHAR(24)'],
      ['action',   'VARCHAR(48)',  'VARCHAR(48)'],
      ['user',     'VARCHAR(120)', 'NVARCHAR(120)'],   // reserved → quote
      ['target',   'VARCHAR(200)', 'NVARCHAR(200)'],
      ['detail',   'VARCHAR(400)', 'NVARCHAR(400)'],
      ['result',   'VARCHAR(24)',  'VARCHAR(24)'],
      ['ip',       'VARCHAR(64)',  'VARCHAR(64)'],
    ],
  },
};

// quote ชื่อคอลัมน์ที่เป็น reserved word ตาม dialect
const RESERVED = new Set(['user', 'group', 'order', 'value']);
function quoteCol(name, dialect) {
  if (!RESERVED.has(name)) return name;
  if (dialect === 'mssql') return `[${name}]`;
  if (dialect === 'mysql') return `\`${name}\``;
  return `"${name}"`;
}

// map ชนิดคอลัมน์ pg → mysql (mysql ไม่มี NVARCHAR/DOUBLE PRECISION · TIMESTAMP ช่วงจำกัด ใช้ DATETIME)
function mysqlType(pg) {
  if (pg === 'TIMESTAMP') return 'DATETIME';
  if (pg === 'DOUBLE PRECISION') return 'DOUBLE';
  return pg;  // VARCHAR(n) เหมือนกัน
}

// สร้าง CREATE TABLE DDL ของ table หนึ่ง ตาม dialect ('pg' | 'mssql' | 'mysql')
function buildDDL(tableName, dialect) {
  const t = TABLES[tableName];
  if (!t) return '';
  const isMs = dialect === 'mssql';
  const isMy = dialect === 'mysql';
  const pk = isMs ? 'id INT IDENTITY PRIMARY KEY'
           : isMy ? 'id INT AUTO_INCREMENT PRIMARY KEY'
           : 'id SERIAL PRIMARY KEY';
  const typeOf = ([, pg, ms]) => isMs ? ms : isMy ? mysqlType(pg) : pg;
  const lines = [pk, ...t.cols.map((col) => `${quoteCol(col[0], dialect)} ${typeOf(col)}`)];
  const body = lines.map((l) => `  ${l}`).join(',\n');
  if (isMs) {
    return `IF OBJECT_ID('${tableName}', 'U') IS NULL\nCREATE TABLE ${tableName} (\n${body}\n);`;
  }
  // pg + mysql รองรับ IF NOT EXISTS · mysql เติม charset
  const tail = isMy ? '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;' : '\n);';
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n${body}${tail}`;
}

// คืน { dialect, tables: { name: { desc, columns:[name...], ddl } } }
function allSchemas(dialect) {
  const d = (dialect === 'mssql' || dialect === 'mysql') ? dialect : 'pg';
  const tables = {};
  for (const name of Object.keys(TABLES)) {
    tables[name] = {
      desc: TABLES[name].desc,
      columns: ['id', ...TABLES[name].cols.map((c) => c[0])],
      ddl: buildDDL(name, d),
    };
  }
  return { dialect: d, tables };
}

module.exports = { TABLES, buildDDL, allSchemas };
