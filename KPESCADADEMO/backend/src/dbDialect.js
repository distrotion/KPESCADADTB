/**
 * dbDialect — helper กลางสำหรับสร้าง SQL ที่ต่าง dialect (mssql / mysql / pg)
 *   ใช้ใน log engine (alarm/device/chart/activity) ที่ auto-create table + insert
 *
 *   placeholder ต่อ dialect:  mssql @p0,@p1…  ·  mysql ?,?…  ·  pg $1,$2…
 *   reserved col quote:       mssql [user]    ·  mysql `user`  ·  pg "user"
 *   timestamp value:          mysql ต้อง 'YYYY-MM-DD HH:MM:SS' (ไม่รับ ISO 'T'/'Z') · pg/mssql รับ ISO
 */

function dialectOf(type) {
  const t = String(type || 'pg').toLowerCase();
  if (t === 'mssql') return 'mssql';
  if (t === 'mysql' || t === 'mariadb') return 'mysql';
  if (t === 'sqlite') return 'sqlite';
  return 'pg';
}

// placeholder list ในวงเล็บ เช่น "(@p0,@p1)" · "(?,?)" · "($1,$2)" · sqlite ใช้ "?" เหมือน mysql
function ph(dialect, count) {
  let arr;
  if (dialect === 'mssql')      arr = Array.from({ length: count }, (_, i) => `@p${i}`);
  else if (dialect === 'mysql' || dialect === 'sqlite') arr = Array.from({ length: count }, () => '?');
  else                          arr = Array.from({ length: count }, (_, i) => `$${i + 1}`);
  return `(${arr.join(',')})`;
}

// quote ชื่อคอลัมน์ (สำหรับ reserved word เช่น user) ตาม dialect
function qcol(name, dialect) {
  if (dialect === 'mssql') return `[${name}]`;
  if (dialect === 'mysql') return `\`${name}\``;
  return `"${name}"`;
}

// แปลง timestamp → ค่าที่ insert ได้ทุก dialect (UTC wall-clock เท่ากันทุกที่)
//   mysql: 'YYYY-MM-DD HH:MM:SS' (strict mode ไม่รับ 'T'/'Z') · pg/mssql: ISO เดิม (คงพฤติกรรม)
function tsVal(dialect, t) {
  const iso = new Date(t).toISOString();
  return dialect === 'mysql' ? iso.slice(0, 19).replace('T', ' ') : iso;
}

module.exports = { dialectOf, ph, qcol, tsVal };
