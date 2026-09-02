const path = require('path');
const csv = require('./csvUtil');

/**
 * MaintenanceManager — ระบบบำรุงรักษา (PM/CM) สำหรับอุปกรณ์/เครื่องจักรใน SCADA
 * ════════════════════════════════════════════════════════════════════════════
 * 3 entity: Asset (อุปกรณ์ · อ้าง device + ลำดับชั้น) · Plan (แผน PM · 4 trigger) · WorkOrder (ใบสั่งงาน)
 *
 * Trigger ของ PM plan:
 *   • time     : ทุก intervalDays วัน
 *   • runtime  : ทุก intervalHours ชั่วโมงเดินเครื่อง (asset run-hours)
 *   • counter  : ทุก intervalCount รอบ (asset counterTag)
 *   • condition: เมื่อ tag เข้าเงื่อนไข (เกิด CM) — ขอบขาขึ้น
 *
 * run-hours ต่อ asset: mode 'tag' (อ่าน runHoursTag ตรง) | 'integrate' (นับเองเมื่อ runningTag จริง)
 * tick ทุก tickMs → integrate run-hours + ประเมิน plan → generate WorkOrder (กันซ้ำถ้ามีใบค้าง)
 * persist: config/maintenance.json (atomic) · ปิด WO → อัปเดต cycle ของ plan (lastDone*)
 * ════════════════════════════════════════════════════════════════════════════
 */

const DAY_MS = 86400000;
const HR_MS = 3600000;
const DEFAULT_TICK = 60000;   // ประเมินทุก 60s

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampNum(v, lo, hi, def) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
function truthy(v) { return v !== null && v !== undefined && v !== false && v !== '' && Number(v) !== 0; }

class MaintenanceManager {
  constructor(tagEngine, opts = {}) {
    this.tagEngine = tagEngine || null;
    this.onWorkOrder = opts.onWorkOrder || (() => {});   // (wo, event) → แจ้ง UI/alarm/popup
    this.assets = [];
    this.plans = [];
    this.workOrders = [];
    this._tick = null;
    this._started = false;
    this._rt = new Map();        // assetId → { lastTs } (integrate run-hours)
    this._condLast = new Map();  // planId → bool (edge ของ condition trigger)
    this._woSeq = 0;
    this.tickMs = clampNum(opts.tickMs, 1000, 3600000, DEFAULT_TICK);
    this._load();
  }

  // ── persistence ─────────────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('maintenance.json', path.join(__dirname, 'config', 'maintenance.json'));
    try {
      const raw = JSON.parse(require('fs').readFileSync(this.path, 'utf8'));
      this.assets = Array.isArray(raw.assets) ? raw.assets.map((a) => this._normAsset(a)) : [];
      this.plans = Array.isArray(raw.plans) ? raw.plans.map((p) => this._normPlan(p)) : [];
      this.workOrders = Array.isArray(raw.workOrders) ? raw.workOrders.map((w) => this._normWo(w)) : [];
      this._woSeq = Number(raw.woSeq) || this.workOrders.length;
    } catch (_) { this.assets = []; this.plans = []; this.workOrders = []; }
  }
  _save() {
    csv.writeJsonAtomic(this.path, { assets: this.assets, plans: this.plans, workOrders: this.workOrders, woSeq: this._woSeq });
  }

  // ── normalize ─────────────────────────────────────────────────────────────
  _normAsset(a) {
    return {
      id: a.id, name: String(a.name || '').trim(), code: String(a.code || '').trim(),
      location: String(a.location || '').trim(),
      parent: String(a.parent || ''),            // assetId แม่ ('' = ราก)
      deviceId: String(a.deviceId || ''),         // อ้าง device SCADA (optional)
      runHoursMode: a.runHoursMode === 'integrate' ? 'integrate' : 'tag',
      runHoursTag: String(a.runHoursTag || ''),   // mode tag: 'device|tag' ชั่วโมงสะสม
      runningTag: String(a.runningTag || ''),     // mode integrate: 'device|tag' (จริง=กำลังเดิน)
      counterTag: String(a.counterTag || ''),     // 'device|tag' จำนวนรอบสะสม
      runHours: num(a.runHours) || 0,             // accumulator (integrate · persist)
      vendor: String(a.vendor || ''), installDate: a.installDate || null,
      note: String(a.note || ''), enabled: a.enabled !== false,
    };
  }
  _normPlan(p) {
    return {
      id: p.id, assetId: String(p.assetId || ''), title: String(p.title || '').trim(),
      instructions: String(p.instructions || ''),
      checklist: Array.isArray(p.checklist) ? p.checklist.map((c) => String(c)) : [],
      trigger: ['runtime', 'counter', 'condition'].includes(p.trigger) ? p.trigger : 'time',
      intervalDays: clampNum(p.intervalDays, 0, 100000, 30),
      intervalHours: clampNum(p.intervalHours, 0, 1e7, 500),
      intervalCount: clampNum(p.intervalCount, 0, 1e9, 10000),
      conditionTag: String(p.conditionTag || ''),       // condition: 'device|tag'
      conditionOp: ['<', '<=', '>', '>=', '==', '!='].includes(p.conditionOp) ? p.conditionOp : '>=',
      conditionValue: num(p.conditionValue) ?? 0,
      leadTimeDays: clampNum(p.leadTimeDays, 0, 3650, 0),
      assignee: String(p.assignee || ''), priority: ['low', 'medium', 'high', 'critical'].includes(p.priority) ? p.priority : 'medium',
      estDurationMin: clampNum(p.estDurationMin, 0, 1e6, 0),
      parts: Array.isArray(p.parts) ? p.parts.map((x) => ({ name: String(x.name || ''), qty: num(x.qty) || 0 })) : [],
      enabled: p.enabled !== false,
      // cycle state (persist)
      lastDoneAt: p.lastDoneAt || null, lastDoneHours: num(p.lastDoneHours), lastDoneCount: num(p.lastDoneCount),
    };
  }
  _normWo(w) {
    return {
      id: w.id, planId: String(w.planId || ''), assetId: String(w.assetId || ''),
      title: String(w.title || '').trim(), source: ['pm', 'condition', 'manual'].includes(w.source) ? w.source : 'manual',
      status: ['open', 'in_progress', 'done', 'closed'].includes(w.status) ? w.status : 'open',
      priority: ['low', 'medium', 'high', 'critical'].includes(w.priority) ? w.priority : 'medium',
      dueAt: w.dueAt || null, createdAt: w.createdAt || null, startedAt: w.startedAt || null,
      doneAt: w.doneAt || null, closedAt: w.closedAt || null,
      assignee: String(w.assignee || ''), doneBy: String(w.doneBy || ''),
      checklist: Array.isArray(w.checklist) ? w.checklist.map((c) => ({ text: String(c.text || c), done: !!c.done, note: String(c.note || '') })) : [],
      partsUsed: Array.isArray(w.partsUsed) ? w.partsUsed.map((x) => ({ name: String(x.name || ''), qty: num(x.qty) || 0, cost: num(x.cost) || 0 })) : [],
      laborMin: num(w.laborMin) || 0, cost: num(w.cost) || 0, downtimeMin: num(w.downtimeMin) || 0,
      notes: String(w.notes || ''), photos: Array.isArray(w.photos) ? w.photos : [], signature: String(w.signature || ''),
    };
  }

  // ── อ่าน tag เป็นตัวเลข ('device|tag' → number|null) ───────────────────────────
  _tagNum(ref) {
    if (!ref || !this.tagEngine) return null;
    const bar = ref.indexOf('|'); if (bar < 0) return null;
    try { const v = this.tagEngine.getTagValue(ref.slice(0, bar), ref.slice(bar + 1)); return v ? num(v.value) : null; }
    catch (_) { return null; }
  }

  // ชั่วโมงเดินเครื่องปัจจุบันของ asset
  assetHours(asset) {
    if (asset.runHoursMode === 'integrate') return asset.runHours || 0;
    return this._tagNum(asset.runHoursTag) ?? (asset.runHours || 0);
  }
  assetCount(asset) { return this._tagNum(asset.counterTag); }

  // ── tick: integrate run-hours + ประเมิน plan ───────────────────────────────────
  _evaluate(now) {
    // 1) integrate run-hours (asset mode=integrate ที่ runningTag จริง)
    for (const a of this.assets) {
      if (!a.enabled || a.runHoursMode !== 'integrate') continue;
      const rt = this._rt.get(a.id) || { lastTs: null };
      if (rt.lastTs != null && truthy(this._tagNum(a.runningTag))) {
        a.runHours = (a.runHours || 0) + (now - rt.lastTs) / HR_MS;
      }
      rt.lastTs = now; this._rt.set(a.id, rt);
    }
    // 2) ประเมิน plan → generate WO
    let dirty = false;
    for (const p of this.plans) {
      if (!p.enabled) continue;
      const asset = this.getAsset(p.assetId);
      if (!asset || asset.enabled === false) continue;
      if (this._openWoFor(p.id)) continue;   // มีใบค้างอยู่ → ข้าม
      const due = this._isDue(p, asset, now);
      if (due.fire) { this._generateWo(p, asset, due.dueAt, now); dirty = true; }
    }
    if (dirty) this._save();
  }

  // เช็คว่า plan ถึงกำหนดไหม → { fire, dueAt }
  _isDue(p, asset, now) {
    if (p.trigger === 'time') {
      const base = p.lastDoneAt || asset.installDate || now;
      const dueAt = (typeof base === 'number' ? base : Date.parse(base) || now) + p.intervalDays * DAY_MS;
      return { fire: now >= dueAt - p.leadTimeDays * DAY_MS, dueAt };
    }
    if (p.trigger === 'runtime') {
      const hrs = this.assetHours(asset);
      const baseH = p.lastDoneHours != null ? p.lastDoneHours : 0;
      return { fire: (hrs - baseH) >= p.intervalHours, dueAt: now };
    }
    if (p.trigger === 'counter') {
      const c = this.assetCount(asset);
      if (c == null) return { fire: false, dueAt: now };
      const baseC = p.lastDoneCount != null ? p.lastDoneCount : c;
      if (p.lastDoneCount == null) { p.lastDoneCount = c; }   // ตั้งฐานครั้งแรก
      return { fire: (c - baseC) >= p.intervalCount, dueAt: now };
    }
    // condition — ขอบขาขึ้น (false→true)
    const v = this._tagNum(p.conditionTag);
    let on = false;
    if (v != null) {
      switch (p.conditionOp) {
        case '<': on = v < p.conditionValue; break;
        case '<=': on = v <= p.conditionValue; break;
        case '>': on = v > p.conditionValue; break;
        case '==': on = v === p.conditionValue; break;
        case '!=': on = v !== p.conditionValue; break;
        default: on = v >= p.conditionValue;
      }
    }
    const prev = this._condLast.get(p.id) || false;
    this._condLast.set(p.id, on);
    return { fire: on && !prev, dueAt: now };
  }

  _openWoFor(planId) {
    return this.workOrders.some((w) => w.planId === planId && w.status !== 'closed');
  }

  _generateWo(p, asset, dueAt, now) {
    const wo = this._normWo({
      id: `wo_${++this._woSeq}`, planId: p.id, assetId: asset.id,
      title: p.title || `PM: ${asset.name}`, source: p.trigger === 'condition' ? 'condition' : 'pm',
      status: 'open', priority: p.priority, dueAt, createdAt: now,
      assignee: p.assignee, checklist: p.checklist.map((t) => ({ text: t, done: false, note: '' })),
    });
    this.workOrders.push(wo);
    try { this.onWorkOrder(wo, 'created'); } catch (_) {}
    return wo;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────
  start() {
    if (this._started) return;
    this._started = true;
    this._tick = setInterval(() => { try { this._evaluate(Date.now()); } catch (_) {} }, this.tickMs);
    // ประเมินรอบแรกทันที (ตั้ง integrate lastTs · ไม่ generate ย้อนหลังเกินจาก lastTs=null)
    try { this._evaluate(Date.now()); } catch (_) {}
  }
  stop() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    try { this._save(); } catch (_) {}
    this._started = false;
  }
  reload() { this.stop(); this._load(); this.start(); }

  // ── CRUD: assets ─────────────────────────────────────────────────────────────
  listAssets() { return this.assets.map((a) => ({ ...a, hoursNow: this.assetHours(a), countNow: this.assetCount(a) })); }
  getAsset(id) { return this.assets.find((a) => a.id === id) || null; }
  _genId(prefix, name, pool) {
    const base = `${prefix}_` + (String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24).toLowerCase() || 'x');
    const exist = new Set(pool.map((x) => x.id)); let id = base, n = 1;
    while (exist.has(id)) id = `${base}_${n++}`; return id;
  }
  createAsset(def) {
    const name = String(def.name || '').trim(); if (!name) throw new Error('name is required');
    const a = this._normAsset({ ...def, id: this._genId('as', name), runHours: 0 });
    this.assets.push(a); this._save(); return a;
  }
  updateAsset(id, up) {
    const i = this.assets.findIndex((a) => a.id === id); if (i === -1) throw new Error('not found');
    const keep = { runHours: this.assets[i].runHours };   // คง accumulator
    this.assets[i] = this._normAsset({ ...this.assets[i], ...keep, ...up, id }); this._save();
    return this.assets[i];
  }
  removeAsset(id) {
    const i = this.assets.findIndex((a) => a.id === id); if (i === -1) return false;
    this.assets.splice(i, 1);
    this.plans = this.plans.filter((p) => p.assetId !== id);   // ลบ plan ของ asset ด้วย
    this._save(); return true;
  }

  // ── CRUD: plans ──────────────────────────────────────────────────────────────
  listPlans() { return this.plans.map((p) => ({ ...p, nextDue: this._nextDue(p) })); }
  getPlan(id) { return this.plans.find((p) => p.id === id) || null; }
  _nextDue(p) {
    const asset = this.getAsset(p.assetId); if (!asset) return null;
    if (p.trigger === 'time') {
      const base = p.lastDoneAt || asset.installDate || Date.now();
      return { type: 'date', at: (typeof base === 'number' ? base : Date.parse(base) || Date.now()) + p.intervalDays * DAY_MS };
    }
    if (p.trigger === 'runtime') {
      const remain = p.intervalHours - (this.assetHours(asset) - (p.lastDoneHours || 0));
      return { type: 'hours', remain };
    }
    if (p.trigger === 'counter') {
      const c = this.assetCount(asset); if (c == null) return { type: 'count', remain: null };
      return { type: 'count', remain: p.intervalCount - (c - (p.lastDoneCount ?? c)) };
    }
    return { type: 'condition' };
  }
  createPlan(def) {
    const title = String(def.title || '').trim(); if (!title) throw new Error('title is required');
    if (!this.getAsset(def.assetId)) throw new Error('asset not found');
    const p = this._normPlan({ ...def, id: this._genId('pm', title) });
    this.plans.push(p); this._save(); return p;
  }
  updatePlan(id, up) {
    const i = this.plans.findIndex((p) => p.id === id); if (i === -1) throw new Error('not found');
    const keep = { lastDoneAt: this.plans[i].lastDoneAt, lastDoneHours: this.plans[i].lastDoneHours, lastDoneCount: this.plans[i].lastDoneCount };
    this.plans[i] = this._normPlan({ ...this.plans[i], ...keep, ...up, id }); this._save();
    return this.plans[i];
  }
  removePlan(id) {
    const i = this.plans.findIndex((p) => p.id === id); if (i === -1) return false;
    this.plans.splice(i, 1); this._save(); return true;
  }

  // ── Work orders ──────────────────────────────────────────────────────────────
  listWorkOrders(filter = {}) {
    let l = this.workOrders;
    if (filter.status) l = l.filter((w) => w.status === filter.status);
    if (filter.assetId) l = l.filter((w) => w.assetId === filter.assetId);
    if (filter.open) l = l.filter((w) => w.status !== 'closed');
    return l.map((w) => ({ ...w }));
  }
  getWo(id) { return this.workOrders.find((w) => w.id === id) || null; }
  createWo(def) {   // CM/manual
    if (!this.getAsset(def.assetId)) throw new Error('asset not found');
    const wo = this._normWo({ ...def, id: `wo_${++this._woSeq}`, source: 'manual',
      status: def.status || 'open', createdAt: Date.now() });
    this.workOrders.push(wo); this._save();
    try { this.onWorkOrder(wo, 'created'); } catch (_) {}
    return wo;
  }
  updateWo(id, up) {
    const i = this.workOrders.findIndex((w) => w.id === id); if (i === -1) throw new Error('not found');
    const prev = this.workOrders[i];
    const merged = this._normWo({ ...prev, ...up, id });
    // timestamp ตามสถานะ
    const now = Date.now();
    if (merged.status === 'in_progress' && !merged.startedAt) merged.startedAt = now;
    if (merged.status === 'done' && !merged.doneAt) merged.doneAt = now;
    if (merged.status === 'closed') {
      merged.closedAt = merged.closedAt || now;
      if (!merged.doneAt) merged.doneAt = now;
      this._completeCycle(merged, now);   // ปิด → รีเซ็ต cycle ของ plan
    }
    this.workOrders[i] = merged; this._save();
    try { this.onWorkOrder(merged, 'updated'); } catch (_) {}
    return merged;
  }
  // ปิด WO → อัปเดต lastDone* ของ plan เพื่อเริ่มรอบใหม่
  _completeCycle(wo, now) {
    const p = this.getPlan(wo.planId); if (!p) return;
    const asset = this.getAsset(wo.assetId);
    p.lastDoneAt = now;
    if (asset) { p.lastDoneHours = this.assetHours(asset); const c = this.assetCount(asset); if (c != null) p.lastDoneCount = c; }
  }
  removeWo(id) {
    const i = this.workOrders.findIndex((w) => w.id === id); if (i === -1) return false;
    this.workOrders.splice(i, 1); this._save(); return true;
  }

  // สรุปสำหรับ dashboard/หน้า Maintenance
  summary() {
    const now = Date.now();
    const open = this.workOrders.filter((w) => w.status !== 'closed');
    const overdue = open.filter((w) => w.dueAt && w.dueAt < now);
    return {
      assets: this.assets.length, plans: this.plans.length,
      open: open.length, overdue: overdue.length,
      inProgress: open.filter((w) => w.status === 'in_progress').length,
    };
  }
}

module.exports = MaintenanceManager;
