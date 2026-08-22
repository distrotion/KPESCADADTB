// script id: script_1787243319584 | name: AUTOPACK_DRAIN | enabled: True
// trigger: {"type": "interval", "intervalMs": 2000}

// AUTOPACK_DRAIN — ส่ง sent=0 จาก 3 ตาราง sqlite ขึ้น .39 (มีเกราะ WiFi ครบตามแบบสถานีชั่ง)
//   RealtimeData → SOI8LOG.dbo.kubotalog (station/weig/code/record_id/plant)
//   BarcodeData  → SOI8LOG.dbo.BarcodeData · FinalData → SOI8LOG.dbo.FinalData
// dup-key = มีบน server แล้ว → ปิดคิว · ล้ม = พัก 30 วิ (tag AP_MSSQL_FAIL_TS — กัน connection ค้างซ้อน)
function mssqlTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('MSSQL timeout ' + ms + 'ms')), ms))]);
}
await db.query('DATA', 'PRAGMA busy_timeout=3000');

const failTs = Number(tag('DATA', 'AP_MSSQL_FAIL_TS') || 0);
if (failTs && Date.now() - failTs < 30000) return;   // เพิ่งล้ม พักก่อน

async function drain(table, buildInsert) {
  const rows = await db.query('DATA', `SELECT * FROM ${table} WHERE sent=0 ORDER BY id LIMIT 3`);
  for (const r of rows) {
    try {
      const [sql, params] = buildInsert(r);
      await mssqlTimeout(db.mssql('AUTO', sql, params), 2500);
      await db.query('DATA', `UPDATE ${table} SET sent=1 WHERE id=?`, [r.id]);
    } catch (e) {
      if (/duplicate key/i.test(e.message)) {
        await db.query('DATA', `UPDATE ${table} SET sent=1 WHERE id=?`, [r.id]);
        log(table, 'มีบน server แล้ว ปิดคิว:', r.record_id);
        continue;
      }
      setTag('DATA', 'AP_MSSQL_FAIL_TS', String(Date.now()));
      log(table, 'ส่งไม่ได้ (WiFi หลุด?) พัก 30 วิ:', String(e.message).slice(0, 70));
      throw e;                                   // หยุดทั้งรอบ — รอ backoff
    }
  }
}

try {
  await drain('RealtimeData', (r) => [
    'INSERT INTO [SOI8LOG].[dbo].[kubotalog] ([station],[weig],[code],[record_id],[plant]) VALUES (@p0,@p1,@p2,@p3,@p4)',
    [r.station, String(r.weig), String(r.code), String(r.record_id).slice(0, 50), r.plant]]);
  await drain('BarcodeData', (r) => [
    'INSERT INTO SOI8LOG.dbo.BarcodeData (src_ts,barcode_rev,fg_order,sm_order,product_name,lot_no,mfg,exp,barcode_fg,pack_size,amount_tank,amount_plan_weight,rtno,plant,record_id,status,error_msg) VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,@p10,@p11,@p12,@p13,@p14,@p15,@p16)',
    [r.ts, r.barcode_rev, r.fg_order, r.sm_order, r.product_name, r.lot_no, r.mfg, r.exp,
     r.barcode_fg, Number(r.pack_size) || 0, Number(r.amount_tank) || 0, Number(r.amount_plan_weight) || 0,
     r.rtno || '', r.plant, String(r.record_id).slice(0, 50), r.status || 'ok', r.error_msg || null]]);
  await drain('FinalData', (r) => [
    'INSERT INTO SOI8LOG.dbo.FinalData (src_ts,counter_final,product_name_final,lot_no_final,barcode_final,vision_ok,vision_ng,weight_final,weight_ok,weight_ng,plant,record_id) VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,@p10,@p11)',
    [r.ts, Number(r.counter_final) || 0, Number(r.product_name_final) || 0, r.lot_no_final || '', r.barcode_final || '',
     Number(r.vision_ok) || 0, Number(r.vision_ng) || 0, Number(r.weight_final) || 0,
     Number(r.weight_ok) || 0, Number(r.weight_ng) || 0, r.plant, String(r.record_id).slice(0, 50)]]);
} catch (_) { /* backoff แล้ว — รอบหน้าลองใหม่ */ }
