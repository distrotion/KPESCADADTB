/**
 * IStockProvider — interface กลางให้ระบบ PM (และระบบอื่น) ขอใช้ Stock โดยไม่ผูกตรง
 * ════════════════════════════════════════════════════════════════════════════
 * สัญญา (contract) — ทุก adapter ต้อง implement:
 *   available(itemId, stockId?) -> number            ยอดที่เบิกได้ (onHand − reserved)
 *   reserve(woId, items[])      -> [{itemId,stockId,qty,available,short}]   จองแบบ soft (กันแย่ง)
 *   release(woId)               -> bool              ปลดจองทั้งหมดของ WO
 *   issue(woId, items[], by?)   -> movements[]       ตัดสต็อกจริง (ปิด WO) + ปลด reserve ที่เหลือ
 *   return(woId, items[], by?)  -> movements[]       คืนของเข้าคลัง
 *   listStocks()                -> stock[]           รายการคลัง (ไม่รวม checkout node)
 *   getItem(itemId)             -> item|null
 *
 * items[] element: { itemId, stockId, qty }
 *
 * adapter ที่วางแผนไว้ (เลือกต่อแหล่ง stock):
 *   native      = เรียก stockManager ในเครื่องตรง (เร็ว · offline) — ตัวนี้
 *   rest        = map ไป REST API ระบบนอก                  (ทำภายหลัง)
 *   erp         = template ERP (SAP/อื่น)                    (ทำภายหลัง)
 *   db-readonly = อ่าน DB ระบบนอก read-only + script เงื่อนไข (ทำภายหลัง)
 *   script      = ผู้ใช้เขียน script แปลงเอง (scriptEngine)   (ทำภายหลัง)
 * → PM ไม่รู้เบื้องหลัง · สลับ adapter โดยไม่แก้ core (strategy pattern)
 * ════════════════════════════════════════════════════════════════════════════
 */

class NativeStockProvider {
  constructor(stockManager) {
    if (!stockManager) throw new Error('NativeStockProvider ต้องมี stockManager');
    this.sm = stockManager;
    this.kind = 'native';
  }
  available(itemId, stockId = null) { return this.sm.available(itemId, stockId); }
  reserve(woId, items) { return this.sm.reserve(woId, items); }
  release(woId) { return this.sm.release(woId); }
  issue(woId, items, by) { return this.sm.issueForWo(woId, items, by); }
  return(woId, items, by) { return this.sm.returnForWo(woId, items, by); }
  listStocks() { return this.sm.listStocks(); }
  getItem(itemId) { return this.sm.getItem(itemId); }
}

// สร้าง provider ตามชนิด (ตอนนี้รองรับ native · ที่เหลือ throw จนกว่าจะทำ)
function createStockProvider(kind, ctx = {}) {
  switch (String(kind || 'native')) {
    case 'native':
      return new NativeStockProvider(ctx.stockManager);
    case 'rest':
    case 'erp':
    case 'db-readonly':
    case 'script':
      throw new Error(`stock provider '${kind}' ยังไม่ implement (ทำในเฟส connector/external)`);
    default:
      throw new Error(`ไม่รู้จัก stock provider '${kind}'`);
  }
}

module.exports = { NativeStockProvider, createStockProvider };
