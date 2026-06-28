/**
 * placeholderResolver — แทน {{...}} ใน SQL / REST / Mongo / ข้อความ ด้วย:
 *   • tag    : {{device|tag}}                → ค่าปัจจุบันของ tag
 *   • date   : {{now}} {{today}} {{now-10d}} → วันเวลา (offset · component · format)
 *
 * ไวยากรณ์ date:
 *   {{ base [±N unit ...] [ .component | | format ] }}
 *     base      = now | today                      (today = เที่ยงคืน local)
 *     unit      = s sec | min | h | d | w | mon month | y year   (mon/y = calendar)
 *     component = year month day hr hour min sec dow epoch        → ตัวเลขดิบ
 *     format    = iso(def) date datetime epoch | "custom"         → string (local time)
 *   วงเล็บใส่ก็ได้: (now-10d).hr  ·  now.hr
 *
 * นาฬิกาฐาน = เวลา "local" ของ server · ส่ง opts.now (Date) เพื่อ test แบบ deterministic
 *
 * target (วิธี output):
 *   sql   : date→'...'(quote local) · component→เลข · tag string→quote+escape · null→NULL
 *   rest  : date→ISO local ดิบ · component→เลข · tag→ดิบ · null→''
 *   raw   : เหมือน rest
 *   mongo : date→{"$date":"<iso>"} (ให้ EJSON.parse เป็น Date) · component→เลข · tag→ดิบ(JSON) · null→null
 */

const UNIT_MS = { s: 1000, sec: 1000, min: 60000, h: 3600000, d: 86400000, w: 604800000 };

function _two(n) { return String(n).padStart(2, '0'); }

// format Date เป็นข้อความ local ตาม token (yyyy MM dd HH mm ss)
function _fmt(d, pattern) {
  return pattern
    .replace(/yyyy/g, d.getFullYear())
    .replace(/MM/g, _two(d.getMonth() + 1))
    .replace(/dd/g, _two(d.getDate()))
    .replace(/HH/g, _two(d.getHours()))
    .replace(/mm/g, _two(d.getMinutes()))
    .replace(/ss/g, _two(d.getSeconds()));
}

// ลองตีความ inner เป็น date expression — คืน { isDate, value } หรือ { isDate:false }
//   value: number (component/epoch) · string (format) · Date (default)
function _parseDate(inner, now) {
  const m = inner.match(
    /^\(?\s*(now|today)\s*((?:[+-]\s*\d+\s*(?:sec|min|month|mon|year|s|h|d|w|y)\b)*)\s*\)?\s*(?:\.(\w+)|\|\s*(.+?))?\s*$/i,
  );
  if (!m) return { isDate: false };
  const [, base, offsets, component, format] = m;

  let d = new Date(now.getTime());
  if (base.toLowerCase() === 'today') { d.setHours(0, 0, 0, 0); }

  // apply offset ทีละตัว (s/min/h/d/w = ms · mon/y = calendar)
  const re = /([+-])\s*(\d+)\s*(sec|min|month|mon|year|s|h|d|w|y)\b/gi;
  let o;
  while ((o = re.exec(offsets || '')) !== null) {
    const sign = o[1] === '-' ? -1 : 1;
    const n = parseInt(o[2], 10);
    const u = o[3].toLowerCase();
    if (u === 'mon' || u === 'month') d.setMonth(d.getMonth() + sign * n);
    else if (u === 'y' || u === 'year') d.setFullYear(d.getFullYear() + sign * n);
    else d = new Date(d.getTime() + sign * n * (UNIT_MS[u] || 0));
  }

  // component → ตัวเลขดิบ
  if (component) {
    const c = component.toLowerCase();
    const map = {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
      hr: d.getHours(), hour: d.getHours(), min: d.getMinutes(), minute: d.getMinutes(),
      sec: d.getSeconds(), second: d.getSeconds(), dow: d.getDay(), epoch: d.getTime(), ms: d.getTime(),
    };
    if (!(c in map)) throw new Error(`component ไม่รู้จัก: .${component}`);
    return { isDate: true, kind: 'num', value: map[c] };
  }

  // format → string
  if (format) {
    const f = format.trim();
    if (f.startsWith('"') && f.endsWith('"')) return { isDate: true, kind: 'str', value: _fmt(d, f.slice(1, -1)) };
    switch (f.toLowerCase()) {
      case 'date':     return { isDate: true, kind: 'str', value: _fmt(d, 'yyyy-MM-dd') };
      case 'time':     return { isDate: true, kind: 'str', value: _fmt(d, 'HH:mm:ss') };
      case 'datetime': return { isDate: true, kind: 'str', value: _fmt(d, 'yyyy-MM-dd HH:mm:ss') };
      case 'epoch':    return { isDate: true, kind: 'num', value: d.getTime() };
      case 'iso':      return { isDate: true, kind: 'str', value: _fmt(d, 'yyyy-MM-ddTHH:mm:ss') };
      default: throw new Error(`format ไม่รู้จัก: |${format}`);
    }
  }

  // default = ทั้ง datetime (Date)
  return { isDate: true, kind: 'date', value: d };
}

// emit ค่า date ตาม target
function _emitDate(res, target) {
  if (res.kind === 'num') return String(res.value);   // component/epoch → เลขดิบ (ทุก target)
  if (res.kind === 'str') {                            // format string
    return target === 'sql' ? `'${res.value}'` : res.value;
  }
  // kind 'date' (default) — ทั้ง datetime
  const iso = _fmt(res.value, 'yyyy-MM-ddTHH:mm:ss');
  if (target === 'sql') return `'${iso}'`;
  if (target === 'mongo') return `{"$date":"${res.value.toISOString()}"}`;  // EJSON → Date จริง
  return iso;                                           // rest/raw
}

// emit ค่า tag ตาม target
function _emitTag(v, target) {
  if (v === null || v === undefined) return target === 'sql' ? 'NULL' : (target === 'mongo' ? 'null' : '');
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (target === 'sql')   return `'${s.replace(/'/g, "''")}'`;
  if (target === 'mongo') return JSON.stringify(s);     // string ใน JSON ต้อง quote ปลอดภัย
  return s;                                             // rest/raw
}

/**
 * resolve(text, opts)
 *   opts.getTag(device, tag) → value | null   (ไม่ส่ง = ไม่แทน tag)
 *   opts.target = 'sql' | 'rest' | 'mongo' | 'raw'   (default 'raw')
 *   opts.now    = Date                               (default new Date())
 */
function resolve(text, opts = {}) {
  if (text == null) return text;
  const target = opts.target || 'raw';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const getTag = typeof opts.getTag === 'function' ? opts.getTag : null;

  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, inner) => {
    // date ก่อน (now/today …)
    const dt = _parseDate(inner, now);
    if (dt.isDate) return _emitDate(dt, target);
    // tag: device|tag
    const bar = inner.indexOf('|');
    if (bar > 0 && getTag) {
      const dev = inner.slice(0, bar).trim();
      const tag = inner.slice(bar + 1).trim();
      let v = null;
      try { const r = getTag(dev, tag); v = r != null ? r : null; } catch (_) { v = null; }
      return _emitTag(v, target);
    }
    return whole;   // ไม่เข้าเงื่อนไข → คงไว้
  });
}

/**
 * dateExpr(expr, format?, now?) — แปลงนิพจน์วันที่เดี่ยว (ไวยากรณ์เดียวกับใน {{...}})
 *   ใช้ใน script context (P4): dateExpr('now-7d') → Date · dateExpr('today') → Date(เที่ยงคืน)
 *     dateExpr('now', 'date') → '2026-06-13' (string) · dateExpr('now-1mon|datetime') ก็ได้
 *     dateExpr('now.year') → 2026 (component=number) · dateExpr('now', 'epoch') → ms
 *   format: iso(def date) | date | time | datetime | epoch | "custom" — เหมือน P1
 *   นาฬิกาฐาน = local ของ server · คืน Date | number | string · throw ถ้านิพจน์ไม่ถูกต้อง
 */
function dateExpr(expr, format, now) {
  const base = String(expr == null ? '' : expr).trim();
  const inner = format ? `${base}|${format}` : base;
  const r = _parseDate(inner, now instanceof Date ? now : new Date());
  if (!r.isDate) throw new Error('dateExpr: นิพจน์วันที่ไม่ถูกต้อง — ' + expr);
  return r.value;   // Date (default) | number (component/epoch) | string (format)
}

module.exports = { resolve, dateExpr, _parseDate, _fmt };
