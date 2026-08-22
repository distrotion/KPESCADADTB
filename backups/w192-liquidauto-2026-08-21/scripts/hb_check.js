// script id: script_1785856299466 | name: hb_check | enabled: True
// trigger: {"type": "interval", "intervalMs": 2000}

// hb_check v2 — heartbeat + drainer ของ LIQUID_AUTO (sqlite sent=0 → MSSQL → sent=1)
const TIMEOUT_MS = 10000;
const t = Number(tag('DATA', 'HB_TS') || 0);
const alive = (t > 0 && (Date.now() - t) <= TIMEOUT_MS) ? 1 : 0;
setTag('DATA', 'SERIAL_HB', alive);
await writeTag('GPIO', 'HB_ALARM', alive ? 0 : 1);

await db.query('DATA', 'PRAGMA busy_timeout=3000');
const rows = await db.query('DATA',
  "SELECT id, weig, code, record_id FROM kubotalog_backup WHERE sent=0 AND station='LIQUID_AUTO' ORDER BY id LIMIT 3");
if (rows.length === 0) { await writeTag('GPIO', 'SOUND', 0); return; }
await writeTag('GPIO', 'SOUND', 1);                // ดังค้าง = ยังส่ง MSSQL ไม่สำเร็จ
for (const r of rows) {
  try {
    await db.mssql('AUTO',
      'INSERT INTO [SOI8LOG].[dbo].[kubotalog] ([station],[weig],[code],[record_id]) VALUES (@p0,@p1,@p2,@p3)',
      ['LIQUID_AUTO', String(r.weig), String(r.code), String(r.record_id == null ? '' : r.record_id).slice(0, 50)]);
    await db.query('DATA', 'UPDATE kubotalog_backup SET sent=1 WHERE id=?', [r.id]);
  } catch (e) { log('MSSQL ยังไม่สำเร็จ รอ retry:', e.message); break; }
}
const left = await db.query('DATA', "SELECT count(*) c FROM kubotalog_backup WHERE sent=0 AND station='LIQUID_AUTO'");
if (!Number(left[0].c)) await writeTag('GPIO', 'SOUND', 0);
