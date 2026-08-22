// script id: script_1787240584418 | name: BARCODE_SAP | enabled: True
// trigger: {"type": "interval", "intervalMs": 1000}

// BARCODE_SAP — ดึงข้อมูล FG/SM จาก SAP (03iPPGETDATACHEM) เมื่อ BARCODE_TRIGER == 1
//   BARCODE_REV = <MATERIAL 8 หลัก><FG PROCESS_ORDER 10 หลัก> เช่น 110013121010017958
//   FGDATA = order จาก BARCODE_REV ตรงตัว · SMDATA = FGDATA.LINK_PROC_ORDER (ต้นทาง)
//   RTNO   = เลขถังจาก hook order-rt บน .34:3012 (ใช้ 5 หลักท้ายของ SM order)
// เขียนแล้วเมื่อไหร่ตั้ง BARCODE_TRIGER = 0 เสมอ (สำเร็จหรือพลาดก็ปลด กันไลน์ค้าง — พลาดจะ log error ไว้)
const DEV = 'LIQUID_AUTOPACK';
const SAP_URL = 'http://172.23.10.168:14094/03iPPGETDATACHEM/GETDATA';
const RT_URL  = 'http://172.23.10.34:3012/api/hooks/order-rt';
const RT_KEY  = 'b16d984e7d245487abd96ec68de7c20d13a9f04aa3bf2351';

function dfmt(d) {
  const p2 = n => String(n).padStart(2, '0');
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear();
}
function sapfmt(d) {                              // SAP ต้องการ dd.MM.yyyy เท่านั้น (คนละแบบกับที่โชว์บนจอ)
  const p2 = n => String(n).padStart(2, '0');
  return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear();
}
function parseSapDate(s) {                       // "20.08.2026" -> Date (เที่ยงคืน local)
  const [dd, mm, yyyy] = String(s).split('.').map(Number);
  return new Date(yyyy, mm - 1, dd);
}
function addShelfLife(start, qty, unit) {         // + shelf life (M/Y/D) แล้ว -1 วัน (สิ้นสุดวันก่อนหมดอายุ)
  const d = new Date(start.getTime());
  if (unit === 'M') d.setMonth(d.getMonth() + qty);
  else if (unit === 'Y') d.setFullYear(d.getFullYear() + qty);
  else d.setDate(d.getDate() + qty);
  d.setDate(d.getDate() - 1);
  return d;
}
async function fetchOrder(processOrder, fr, to) {
  const res = await fetch(SAP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      HEADER: { PLANT: '1000', ORD_ST_DATE_FR: fr, ORD_ST_DATE_TO: to, ORDER_TYPE: '', PROD_SUP: '' },
      PROC_ORD: [{ PROCESS_ORDER: String(processOrder), MATERIAL: '' }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  return (j.HEADER_INFO || [])[0] || null;
}

if (Number(tag(DEV, 'BARCODE_TRIGER')) !== 1) return;   // ไม่ใช่จังหวะทำงาน
if (state.busy) return;                                  // กันเข้าซ้อนระหว่างรอ SAP ตอบ (หลาย tick)
state.busy = true;

let barcodeRev = '', fgOrder = '', smOrder = '', failed = false;
try {
  barcodeRev = String(tag(DEV, 'BARCODE_REV') || '').trim();
  const material = barcodeRev.slice(0, 8);
  fgOrder = barcodeRev.slice(8);
  if (!fgOrder) throw new Error('BARCODE_REV สั้นเกินไป/ว่าง: "' + barcodeRev + '"');

  const today = new Date();
  const to = sapfmt(today);
  const from10 = new Date(today.getTime()); from10.setDate(from10.getDate() - 10);
  const fr = sapfmt(from10);   // ช่วงเดียวครอบ "ย้อนหลัง 10 วัน" — API รับเป็น date range อยู่แล้ว ไม่ต้อง loop ทีละวัน

  const fg = await fetchOrder(fgOrder, fr, to);
  if (!fg) throw new Error('ไม่พบ FG order ' + fgOrder + ' ในช่วง ' + fr + '..' + to);

  smOrder = fg.LINK_PROC_ORDER;
  const sm = smOrder ? await fetchOrder(smOrder, fr, to) : null;
  if (!sm) throw new Error('ไม่พบ SM order (LINK_PROC_ORDER=' + smOrder + ')');

  const productName = String(sm.MATERIAL_TEXT || '').split('|')[0].trim();
  const lotNo = String(sm.BATCH || '');
  const mfg = dfmt(parseSapDate(sm.BASIC_START_DATE));               // SAP ส่งมา dd.MM.yyyy → แปลงเป็น dd/MM/yyyy (W192 เท่านั้น)
  const exp = dfmt(addShelfLife(parseSapDate(sm.BASIC_START_DATE), Number(sm.TOTAL_SHELF_LIFE) || 0, sm.PERIOD_IND_SLED));
  const barcodeFg = String(fg.MATERIAL || '') + String(fg.BATCH || '');
  const packSize = parseFloat(String(fg.MATERIAL_TEXT || '').split('|')[1]?.replace(/[^\d.]/g, '') || '0');
  const amountPlanWeight = Number(fg.TOTAL_QTY) || 0;
  const amountTank = packSize ? Math.round(amountPlanWeight / packSize) : 0;

  let rtno = '';
  try {
    const smShort = String(smOrder).slice(-5);
    const rtRes = await fetch(RT_URL + '?order=' + smShort,
      { headers: { 'x-api-key': RT_KEY }, signal: AbortSignal.timeout(8000) });
    const rtJson = await rtRes.json();
    rtno = rtJson.found ? rtJson.rt : '';   // ไม่เจอ = ปล่อยว่าง (ไม่ทำให้ทั้งรอบพัง เพราะฟิลด์อื่นสำเร็จแล้ว)
    if (!rtno) log('ไม่พบถังของ order', smShort, '— RTNO เว้นว่าง');
  } catch (e) { log('order-rt hook พลาด:', e.message, '— RTNO เว้นว่าง'); }

  await writeTag(DEV, 'ProductName', productName);
  await writeTag(DEV, 'LotNO', lotNo);
  await writeTag(DEV, 'MFG', mfg);
  await writeTag(DEV, 'EXP', exp);
  await writeTag(DEV, 'BarcodeFG', barcodeFg);
  await writeTag(DEV, 'PackSize', String(packSize));
  await writeTag(DEV, 'AmountTank', amountTank);
  await writeTag(DEV, 'RTNO', rtno);
  // PGMNO (D3120) — placeholder ชั่วคราว fix=1 (user สั่ง 2026-08-21)
  //   ของจริงจะมาจากอีกระบบหนึ่งแยกต่างหาก (ผู้รับเหมายังทำไม่เสร็จ) — เลิกฟิกตรงนี้เมื่อระบบนั้นพร้อม
  await writeTag(DEV, 'PGMNO', 1);
  await writeTag(DEV, 'AmountPlanWeight', amountPlanWeight);

  // ── บันทึกลง sqlite BarcodeData (sqlite-first · sent=0 → drainer ส่งขึ้น .39) ──
  try {
    const nowMs = Date.now();
    await db.query('DATA', 'PRAGMA busy_timeout=3000');
    await db.query('DATA',
      'INSERT INTO BarcodeData (ts,barcode_rev,fg_order,sm_order,product_name,lot_no,mfg,exp,barcode_fg,pack_size,amount_tank,amount_plan_weight,rtno,plant,record_id,sent,status,error_msg) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)',
      [new Date(nowMs).toISOString(), barcodeRev, fgOrder, smOrder, productName, lotNo, mfg, exp,
       barcodeFg, packSize, amountTank, amountPlanWeight, rtno, 'LIQUID', 'LIQUID_AUTO-BC-' + nowMs, 'ok', null]);
  } catch (e2) { log('บันทึก BarcodeData ไม่ได้:', e2.message); }

  log('SAP OK:', productName, lotNo, '| FG', fgOrder, '→ SM', smOrder, '| RT', rtno || '-');
} catch (e) {
  failed = true;
  log('SAP lookup ล้มเหลว:', e.message);
  // บันทึกความล้มเหลวลง history ด้วย (user สั่ง 2026-08-21)
  try {
    const nowMs2 = Date.now();
    await db.query('DATA', 'PRAGMA busy_timeout=3000');
    await db.query('DATA',
      'INSERT INTO BarcodeData (ts,barcode_rev,fg_order,sm_order,product_name,lot_no,mfg,exp,barcode_fg,pack_size,amount_tank,amount_plan_weight,rtno,plant,record_id,sent,status,error_msg) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)',
      [new Date(nowMs2).toISOString(), barcodeRev, fgOrder, smOrder || '', '', '', '', '',
       '', 0, 0, 0, '', 'LIQUID', 'LIQUID_AUTO-BCERR-' + nowMs2, 'failed', String(e.message).slice(0, 490)]);
  } catch (e3) { log('บันทึก BarcodeData(failed) ไม่ได้:', e3.message); }
} finally {
  state.busy = false;
  // สำเร็จ → 0 (ปลดปกติ) · อ่าน SAP ไม่ได้ → 7 (error code แจ้ง PLC/HMI ว่าล้มเหลว) — user สั่ง 2026-08-21
  await writeTag(DEV, 'BARCODE_TRIGER', failed ? 7 : 0);
}
