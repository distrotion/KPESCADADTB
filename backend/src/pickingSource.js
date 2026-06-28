// pickingSource.js — Picking-Out (Delivery) ผ่าน gateway กลาง (version API · แทน PDF import)
//   POST http://172.23.10.168:14090/DATAGW/TMI001GET (gateway ถือ SECRET_KEY/BAPI=ZFMTM_CHEMICAL_PICKING_OUT ให้)
//   body: { date_from, date_to, invoice_no } (date = DD.MM.YYYY) · response: { INFO: [ {row} ], TYPE, MESSAGE }
//   *** KPE ไม่ต้องถือ key เลย (เหมือน SAP incoming QMI002GET) · อ่านอย่างเดียว → map → pickingManager.import ***
const http = require('http');
const https = require('https');
const { URL } = require('url');
const TtlCache = require('./ttlCache');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function stripMat(mc) { return String(mc == null ? '' : mc).trim().replace(/^0+/, ''); }

// POST JSON → resolve parsed JSON (รองรับทั้ง http/https · https ยอม self-signed)
function httpPostJson(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('bad picking url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } };
    if (u.protocol === 'https:') opts.rejectUnauthorized = false;
    const req = lib.request(opts, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(`picking gateway: bad JSON (HTTP ${res.statusCode})`)); } });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('picking gateway timeout')));
    req.write(data); req.end();
  });
}

// วันที่ → YYYYMMDD (gateway/BAPI ใช้ format นี้ · กรองวันได้จริง · ทดสอบ 2026-06-19: DD.MM.YYYY=ไม่กรอง · YYYY.MM.DD=0 · YYYYMMDD=ตรงวัน) · รับ DD.MM.YYYY / YYYY-MM-DD / YYYYMMDD
function toApiDate(s) {
  const v = String(s || '').trim();
  if (/^\d{8}$/.test(v)) return v;                              // already YYYYMMDD
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);                   // YYYY-MM-DD
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);                    // DD.MM.YYYY (จาก frontend)
  if (m) return `${m[3]}${m[2]}${m[1]}`;
  return v;
}

class PickingSource {
  // { stock, url } · ยิงผ่าน gateway กลาง — ไม่ถือ key (gateway จัดการ SECRET_KEY/BAPI ให้)
  constructor({ stock, url = 'http://172.23.10.168:14090/DATAGW/TMI001GET' } = {}) {
    this.stock = stock; this.url = url;
    this.cache = new TtlCache();   // buffer กลาง — ลด transaction ไป gateway (เหมือน SAP incoming)
    this._lastOkAt = 0;   // epoch ms ของ fetch สำเร็จ (มีข้อมูลจริง) ล่าสุด → widget โชว์ "last sync"
  }
  lastSyncAt() { return this._lastOkAt; }
  _cfg(k) { return this.stock && this.stock.config ? this.stock.config[k] : undefined; }
  _ttl() { const m = Number(this._cfg('pickingFeedMin')); return (m > 0 ? m * 60 : (Number(this._cfg('extCacheTtlSec')) || 300)) * 1000; }   // รอบ buffer picking (นาที · default 5) ปรับได้
  _url() { return this._cfg('pickingApiUrl') || this.url; }   // gateway กลาง (ถือ key/BAPI ให้) · override ได้ใน config
  invalidate() { this.cache.clear(); }

  // map INFO rows → picking lines (รูปแบบที่ pickingManager.import รับ · lineId เสถียร → dedup ส่งมอบคงอยู่ข้าม pull)
  _map(rows) {
    const seen = new Map();
    return (rows || []).map((r) => {
      const matCode = stripMat(r.MATERIAL_NO);
      const delivery = String(r.DELIVERY_NO || '').trim();
      const batch = String(r.LOT_NUMBER || '').trim();
      const key = `${delivery}:${matCode}:${batch}`;
      const occ = seen.get(key) || 0; seen.set(key, occ + 1);
      const lineId = occ ? `${key}#${occ}` : key;   // ชน key เดิมในชุดเดียว → ต่อ #n (เสถียรตามลำดับ source)
      return {
        lineId, delivery,
        shipTo: String(r.CUSTOMER_NAME || r.DELIV_LOC_DESC || '').trim(),
        shipToCode: String(r.CUSTOMER_NO || r.SHIP_TO_PARTY || '').trim(),
        matCode, name: String(r.MATERIAL_DESC || '').trim(),
        salesQty: num(r.DELIVERY_QTY), salesUom: '',   // API ไม่ให้ UOM → deriveSaleQty อ่าน pack size จากชื่อ
        batch, route: String(r.ROUTE_DESC || r.ROUTE_CODE || '').trim(),
        // วันที่ส่งมอบ (เผื่อชื่อ field ที่ SAP delivery มักใช้ · gateway ส่งมา = กรอง N วัน client ได้ · ไม่ส่ง = ว่าง→ไม่กรอง)
        delivDate: String(r.DELIVERY_DATE || r.DELIV_DATE || r.LFDAT || r.DOC_DATE || r.CREATE_DATE || r.GI_DATE || r.BILL_DATE || '').trim(),
        expiry: '',
      };
    });
  }

  // ดึง picking-out จาก gateway กลาง (cached) → คืน lines (mapped) · gateway คืน { INFO, TYPE, MESSAGE } ชั้นบนสุด
  async fetchPickingOut({ fromDate, toDate, invoiceNo = '', noCache = false } = {}) {
    const body = { date_from: toApiDate(fromDate), date_to: toApiDate(toDate), invoice_no: String(invoiceNo || '') };
    const fetcher = async () => {
      const j = await httpPostJson(this._url(), body, {}, 30000);   // gateway ถือ SECRET_KEY/BAPI ให้ → ไม่ส่ง header เพิ่ม
      const info = j && Array.isArray(j.INFO) ? j.INFO : [];
      const r = this._map(info); if (r.length) this._lastOkAt = Date.now(); return r;
    };
    const cacheKey = `pk:${body.date_from}:${body.date_to}:${body.invoice_no}`;
    return this.cache.getOrFetch(cacheKey, fetcher, this._ttl(), { stickyNonEmpty: true, force: noCache });   // noCache=hard refresh (ดึงสด+เขียนทับ buffer)
  }
}

module.exports = { PickingSource, httpPostJson, toApiDate, stripMat };
