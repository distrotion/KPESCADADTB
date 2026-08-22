// script id: script_1785920169473 | name: reconcile | enabled: True
// trigger: {"type": "interval", "intervalMs": 60000}

// reconcile — เทียบของในเครื่อง (sqlite) กับ server .39 ด้วย record_id ↔ etc
// MISS_CNT = จำนวนที่เครื่องบอกว่าส่งแล้ว (sent=1) แต่หาไม่เจอบน server
const STATION = 'LIQUID_AUTO';
const WINDOW_H = 24;
const cutoff = new Date(Date.now() - WINDOW_H * 3600 * 1000).toISOString();

await db.query('DATA', 'PRAGMA busy_timeout=3000');
const local = await db.query('DATA',
  'SELECT record_id FROM kubotalog_backup WHERE sent=1 AND station=? AND record_id IS NOT NULL AND ts >= ?',
  [STATION, cutoff]);
if (local.length === 0) { setTag('DATA', 'MISS_CNT', 0); setTag('DATA', 'MISS_IDS', ''); return; }

const srv = await db.mssql('AUTO',
  "SELECT record_id FROM [SOI8LOG].[dbo].[kubotalog] WHERE station=@p0 AND [date] >= DATEADD(hour,-24,GETDATE()) AND record_id IS NOT NULL AND record_id <> ''",
  [STATION]);
const have = new Set(srv.map((r) => r.record_id));
const missing = local.map((r) => r.record_id).filter((id) => !have.has(id));

setTag('DATA', 'MISS_CNT', missing.length);
setTag('DATA', 'MISS_IDS', missing.slice(0, 20).join(','));
if (missing.length) log('หายบน server', missing.length, 'จาก', local.length, ':', missing.slice(0, 5).join(','));
