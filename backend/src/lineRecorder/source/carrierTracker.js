// carrierTracker.js — แก่น snapshot source: จำตำแหน่ง (latch) + ตรวจการขยับ (diff) → canonical events
//   ของ node-red กระจายใน decoder BF0 + State diff 92 ตัว → รวมไว้ที่เดียว test ได้
//   state ต่อ line (in-memory v1 · restart reset — persist เป็นงานถัดไป)
//
//   update(line, snapshot, cfg, now) → events[]   (event = รูปเดียวกับ decoder → engine.project ได้)
//   snapshot = [{ pos, station, identity, params:{key:val} }] (เรียงตาม pos: entry→exit ก็ได้/sort ให้)
//   identity = "เลขที่เข้ามา" (carrier) · 0/null = ตำแหน่งว่าง · params latch ค่าล่าสุดที่ ≠ 0 (ตาม BF0 เดิม)

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// 2 หลักวันที่ YYYYMMDD (group job ต่อวัน · ใช้ใน jobKey)
function _fmtDate(ts) {
  const d = new Date(ts); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// latch ค่า param ที่ ≠ 0 ลง acc (เก็บค่าดีล่าสุดตอน carrier อยู่ที่ตำแหน่ง)
function _latch(acc, params) {
  acc = acc || {};
  for (const k in (params || {})) {
    const v = Number(params[k]);
    if (Number.isFinite(v) && v !== 0) acc[k] = v;
  }
  return acc;
}

// สะสมสถิติ min/max/sum/count ต่อ key ทุก poll ระหว่าง carrier อยู่ในบ่อ (ignore 0/non-finite ตาม latch)
function _accStats(acc, params) {
  acc = acc || {};
  for (const k in (params || {})) {
    const v = Number(params[k]);
    if (!Number.isFinite(v) || v === 0) continue;
    const a = acc[k] || (acc[k] = { min: v, max: v, sum: 0, count: 0 });
    if (v < a.min) a.min = v;
    if (v > a.max) a.max = v;
    a.sum += v; a.count += 1;
  }
  return acc;
}

// ── minigraph: เก็บ series ค่าระหว่างชุบต่อ param ที่เปิด track.graph ──
const GRAPH_EVERY_MS = 5000;   // sample ทุก ~5s (poll ถี่กว่านี้ = ข้าม)
const GRAPH_MAX_PTS = 300;     // เกิน → downsample ครึ่ง (เว้นจุด)

// สะสมจุดลง g = { t0, last, every, s:{key:{dt:[],v:[]}} } · เฉพาะ key ใน graphKeys · ignore 0 ตาม latch
function _accSeries(g, params, graphKeys, now) {
  if (!graphKeys || !graphKeys.size) return g;
  g = g || { t0: now, last: 0, every: GRAPH_EVERY_MS, s: {} };
  if (now - g.last < g.every) return g;
  let wrote = false;
  for (const k of graphKeys) {
    const v = Number((params || {})[k]);
    if (!Number.isFinite(v) || v === 0) continue;
    const sk = g.s[k] || (g.s[k] = { dt: [], v: [] });
    sk.dt.push(Math.round((now - g.t0) / 1000)); sk.v.push(v);
    wrote = true;
    if (sk.dt.length > GRAPH_MAX_PTS) {   // downsample ครึ่ง (เว้นจุดเว้นจุด) + ยืดคาบ
      sk.dt = sk.dt.filter((_, i) => i % 2 === 0);
      sk.v = sk.v.filter((_, i) => i % 2 === 0);
      g.every *= 2;
    }
  }
  if (wrote) g.last = now;
  return g;
}

// แปลง g → ev.series {key:{t0,dt,v}} (เฉพาะ key ที่มีข้อมูล) · null ถ้าว่าง
//   keep = จำกัดเฉพาะ key ที่เปิด minigraph (mid ใช้ series ร่วมแต่ไม่ต้องเก็บลงตาราง)
function _seriesOut(g, keep) {
  if (!g) return null;
  const out = {};
  for (const k in g.s) {
    if (keep && !keep.has(k)) continue;
    if (g.s[k].dt.length) out[k] = { t0: g.t0, dt: g.s[k].dt, v: g.s[k].v };
  }
  return Object.keys(out).length ? out : null;
}

// ค่า ณ "กึ่งกลางเวลา" ที่อยู่ในบ่อ — หยิบ sample ที่ ts ใกล้จุดกึ่งกลางที่สุด (ไม่ interpolate)
//   ความละเอียด = คาบ sample ของ series (~5s · downsample แล้วยืดคาบ)
function _midOf(g, key, midTs) {
  const sk = g && g.s && g.s[key];
  if (!sk || !sk.dt.length || midTs == null) return null;
  let best = null, bestGap = Infinity;
  for (let i = 0; i < sk.dt.length; i++) {
    const ts = g.t0 + sk.dt[i] * 1000;
    const gap = Math.abs(ts - midTs);
    if (gap < bestGap) { bestGap = gap; best = sk.v[i]; }
  }
  return best;
}

// key ของ field ที่เปิด minigraph (track.graph)
function _graphKeys(cfg) {
  const s = new Set();
  for (const f of ((cfg && cfg.fields) || [])) { if (f.track && f.track.graph) s.add(f.key); }
  return s;
}

// key ที่ต้องสะสม series = minigraph (graph) + ค่ากลางเวลา (summary='mid' ต้องมี sample ตามเวลา)
//   mid ใช้ series เป็นตัวช่วยคำนวณเท่านั้น — ไม่ถูกเก็บลงตาราง series (ดู _seriesOut(keep))
function _seriesKeys(cfg) {
  const s = _graphKeys(cfg);
  for (const f of ((cfg && cfg.fields) || [])) { if (f.track && f.track.summary === 'mid') s.add(f.key); }
  return s;
}

// สรุปค่าตอน exit ตาม track ของแต่ละ field → { values (last หรือ avg), stats:{key:{min,max,avg,last}} }
//   default (ไม่ track) = values เดิม 100% · stats = {} (ไม่แนบ · backward compatible)
function _summarize(cfg, params, stats, graph, enterTs, exitTs) {
  const values = { ...(params || {}) };
  const out = {};
  // จุดกึ่งกลางเวลาที่อยู่ในบ่อ (ต้องรู้ทั้งเข้า-ออก) — ไม่รู้ = ใช้ t0 ของ series แทน (robust)
  const midTs = (enterTs != null && exitTs != null) ? (Number(enterTs) + Number(exitTs)) / 2 : null;
  for (const f of ((cfg && cfg.fields) || [])) {
    const tr = f.track || {};
    const wantAvg = tr.summary === 'avg';
    const wantMid = tr.summary === 'mid';
    if (!tr.minMax && !wantAvg && !wantMid) continue;
    const s = stats && stats[f.key];
    if (!s || !s.count) continue;
    const avg = Math.round((s.sum / s.count) * 1e6) / 1e6;
    const mid = _midOf(graph, f.key, midTs != null ? midTs : (graph ? graph.t0 : null));
    if (wantAvg) values[f.key] = avg;                          // ค่าที่แสดง/สเปก = ค่าเฉลี่ย (แทนค่าสุดท้าย)
    else if (wantMid && mid != null) values[f.key] = mid;      // = ค่ากลางเวลา · ไม่มี sample → คงค่าสุดท้าย (ไม่ทิ้งข้อมูล)
    out[f.key] = { min: s.min, max: s.max, avg, last: params[f.key] != null ? Number(params[f.key]) : null };
    if (mid != null) out[f.key].mid = mid;
  }
  return { values, stats: out };
}

class CarrierTracker {
  constructor() { this.state = {}; }   // line → { occ:{pos:{carrier,params}}, jobs:{carrier:ctx}, runs:{"date|carrier":n} }

  reset(line) { if (line) delete this.state[line]; else this.state = {}; }
  _st(line) {
    const s = this.state[line] || (this.state[line] = { occ: {}, jobs: {}, runs: {}, oven: {} });
    if (!s.runs) s.runs = {};   // กู้ state เก่าที่ยังไม่มี runs
    if (!s.oven) s.oven = {};   // กู้ state เก่าที่ยังไม่มี oven (เตาอบ: content+diff ต่อ station)
    return s;
  }

  // อ่าน state ปัจจุบัน (debug/mimic)
  snapshotState(line) { const s = this.state[line]; return s ? { occ: { ...s.occ }, jobs: { ...s.jobs }, runs: { ...(s.runs || {}) }, oven: { ...(s.oven || {}) } } : { occ: {}, jobs: {}, runs: {}, oven: {} }; }

  // persist (restart-safe) — state เป็น plain object อยู่แล้ว
  serialize() { return this.state; }
  load(obj) { this.state = (obj && typeof obj === 'object') ? obj : {}; return this; }

  // เริ่ม job (ctx + นับ run) — key ด้วย (set,carrier) → carrier ซ้ำข้ามแถวได้ไม่ชน
  _startCtx(st, set, nid, now, lane, gap) {
    const ctx = { dateKey: _fmtDate(now), set, lane, enterTs: now, gap };
    const rk = set + '|' + ctx.dateKey + '|' + nid;
    const cnt = (st.runs[rk] = (st.runs[rk] || 0) + 1);
    if (cnt > 1) ctx.run = cnt;
    st.jobs[set + ':' + nid] = ctx;
    return ctx;
  }

  // หา ctx ของ carrier (ข้าม set · ไม่รวม pending '@:') — ใช้ตอน oven/reentry (carrier เดียวอาจอยู่ set ไหนก็ได้)
  _findCtxByCarrier(st, nid) {
    for (const k of Object.keys(st.jobs)) {
      if (k.startsWith('@:')) continue;
      if (k.slice(k.indexOf(':') + 1) === String(nid)) return st.jobs[k];
    }
    return null;
  }

  // oven (เตาอบ) — เข้าที่ inTag · ออกที่ outTag (เลข carrier ตรง ๆ) · อบเป็นชุด (หลายชิ้น) · เวลาอบ = ออก−เข้า
  //   ov.c = content (carrier→{inTime,params}) · ov.li/ov.lo = ค่า in/out ล่าสุด (diff)
  _oven(st, p, pos, pset, cfg, now, events, mk, laneOf, lastBySet) {
    const stn = String(p.station);
    const ov = st.oven[stn] || (st.oven[stn] = { c: {}, li: null, lo: null, params: {} });
    ov.params = _latch(ov.params || {}, p.params);   // อุณหภูมิเตา "สด" ทุก poll (latch ค่าล่าสุดที่ ≠ 0) → monitor โชว์ live
    for (const cr in ov.c) { ov.c[cr].params = _latch(ov.c[cr].params || {}, p.params); ov.c[cr].stats = _accStats(ov.c[cr].stats || {}, p.params); ov.c[cr].graph = _accSeries(ov.c[cr].graph, p.params, _seriesKeys(cfg), now); }   // latch + min/max/avg + minigraph ให้ทุก carrier ที่กำลังอบ
    const valid = (v) => !(v === null || v === undefined || v === '' || !Number.isFinite(Number(v)));   // null=comms loss → คงสถานะ
    // เข้า oven (inTag เปลี่ยนเป็นเลขใหม่ที่ยังไม่อยู่ในเตา)
    if (valid(p.inId)) {
      const inId = Number(p.inId);
      if (inId !== 0 && inId !== ov.li && !ov.c[inId]) {
        let ctx = this._findCtxByCarrier(st, inId);
        if (!ctx) {
          const pend = st.jobs['@:' + inId];
          if (pend) {                                  // register จากจุดเข้า รออยู่ → materialize ที่ oven (เผื่อ oven เป็นจุดแรก)
            delete st.jobs['@:' + inId];
            ctx = this._startCtx(st, pset, inId, pend.enterTs, pend.lane || laneOf(p), false);
            ctx.dateKey = pend.dateKey; ctx.enterTs = pend.enterTs; ctx.data = { ...(pend.data || {}) };
            events.push(mk('ENTER', inId, p, ctx.data, ctx));
          } else {                                     // โผล่ที่ oven ตรง ๆ ไม่เคยเห็น = gap
            ctx = this._startCtx(st, pset, inId, now, laneOf(p), true);
            ctx.data = {};
            events.push(mk('ENTER', inId, p, {}, ctx));
          }
        } else if (ctx.exited) {                       // เพิ่งออกบ่อ (done) → เข้า oven = running อีกครั้ง
          ctx.exited = false;
          const re = mk('ENTER', inId, p, {}, ctx); re.reentry = true; events.push(re);
        }
        if (ctx.firstBoTs == null) ctx.firstBoTs = now;
        ctx.lastSeenTs = now; ctx.lastStation = p.station;
        ov.c[inId] = { inTime: now, params: _latch({}, p.params), stats: _accStats({}, p.params), graph: _accSeries(null, p.params, _seriesKeys(cfg), now) };
      }
      ov.li = inId;
    }
    // ออก oven (outTag เปลี่ยนเป็นเลขใหม่) → STEP เวลาอบ + (ถ้า finish/บ่อสุดท้าย) EXIT
    if (valid(p.outId)) {
      const outId = Number(p.outId);
      if (outId !== 0 && outId !== ov.lo) {
        const rec = ov.c[outId];
        const ctx = this._findCtxByCarrier(st, outId);
        if (ctx) {
          const dwellS = (rec && rec.inTime != null) ? Math.round((now - rec.inTime) / 1000) : null;   // เวลาอบ (วินาที) · out ก่อน in = null (robust)
          const rawParams = rec ? rec.params : _latch({}, p.params);
          const summ = _summarize(cfg, rawParams, rec ? rec.stats : null, rec ? rec.graph : null, rec ? rec.inTime : null, now);   // สรุป last/avg + min/max ตาม track
          const params = summ.values;
          const hasStats = Object.keys(summ.stats).length > 0;
          const stepEv = mk('STEP', outId, p, params, ctx);
          stepEv.enterTs = rec ? rec.inTime : null; stepEv.exitTs = now; stepEv.dwell = dwellS;
          if (hasStats) stepEv.stats = summ.stats;
          const ser = rec ? _seriesOut(rec.graph, _graphKeys(cfg)) : null;   // minigraph ช่วงอบ
          if (ser) stepEv.series = ser;
          events.push(stepEv);
          const isFinish = !!((cfg.stations || {})[stn] || {}).finish;
          const isLast = pos === lastBySet[pset];
          if (isFinish || isLast) {                    // oven ปลายไลน์ = ขาออก (done)
            const ex = mk('EXIT', outId, p, params, ctx);
            ex.enterTs = rec ? rec.inTime : null; ex.exitTs = now; ex.dwell = dwellS;
            if (hasStats) ex.stats = summ.stats;
            events.push(ex); ctx.exited = true;
          }
          ctx.lastExitTs = now; ctx.lastSeenTs = now; ctx.lastStation = p.station; ctx.lastParams = { ...params };
        }
        if (rec) delete ov.c[outId];
      }
      ov.lo = outId;
    }
  }

  // ลงทะเบียนงานจาก "จุดเข้า/conveyor" (trigger) — เก็บ barcode ไว้เป็น "pending" (ยังไม่รู้ set/แถว)
  //   ยังไม่สร้าง job/ENTER · รอ materialize ตอนเข้าบ่อจริง (จุดเข้าเดียว serve หลายแถวได้ → set จริงรู้ตอนเข้าบ่อ · กัน barcode หาย/row ซ้ำ)
  //   คืน null เสมอ (ไม่มี event ให้ project) · pending เก็บใน st.jobs['@:'+nid] → entrance โชว์เป็น register ได้
  registerJob(line, carrier, { lane = '', jobValues = {}, station = '' } = {}, cfg, now) {
    now = now || Date.now();
    const st = this._st(line);
    const nid = Number(carrier);
    if (!Number.isFinite(nid) || nid === 0) return null;
    for (const k of Object.keys(st.jobs)) { if (k.slice(k.indexOf(':') + 1) === String(nid)) return null; }   // มี carrier นี้อยู่แล้ว (pending/กำลังวิ่ง) — ไม่ซ้ำ
    st.jobs['@:' + nid] = { pending: true, set: null, lane, dateKey: _fmtDate(now), enterTs: now, firstBoTs: null, data: { ...jobValues }, gap: false };
    return null;
  }

  update(line, snapshot, cfg, now, opts) {
    now = now || Date.now();
    cfg = cfg || {}; opts = opts || {};
    const jobValues = opts.jobValues || null;            // job-level (barcode ฯลฯ) แนบตอน ENTER (โหมดบ่อแรก)
    const st = this._st(line);
    const events = [];
    const positions = (Array.isArray(snapshot) ? snapshot.slice() : []).sort((a, b) => (_num(a.pos)) - (_num(b.pos)));
    if (!positions.length) return events;

    const setOf = (station) => { const s = (cfg.stations || {})[String(station)] || {}; return s.set != null ? String(s.set) : '1'; };   // แถว/set ของบ่อ
    // first/last pos ต่อแถว (set) — EXIT/entry คิดแยกแต่ละแถว
    const firstBySet = {}, lastBySet = {};
    for (const p of positions) {
      const s = setOf(p.station), ps = _num(p.pos);
      if (firstBySet[s] === undefined || ps < firstBySet[s]) firstBySet[s] = ps;
      if (lastBySet[s] === undefined || ps > lastBySet[s]) lastBySet[s] = ps;
    }

    const meta = (station) => {
      const s = (cfg.stations || {})[String(station)] || {};
      return { stationName: s.name || '', stationType: s.type || '', seq: s.seq != null ? Number(s.seq) : null };
    };
    const laneOf = (p) => (p.lane != null ? String(p.lane)
      : (cfg.source && cfg.source.lane != null ? String(cfg.source.lane) : ''));
    const mk = (type, carrier, p, values, ctx) => {
      const m = meta(p.station);
      return {
        line, type, carrier: String(carrier), lane: ctx.lane, dateKey: ctx.dateKey, set: ctx.set, run: ctx.run != null ? ctx.run : null,
        station: p.station != null ? String(p.station) : '', stationName: m.stationName, stationType: m.stationType, seq: m.seq,
        enterTs: ctx.enterTs || null, exitTs: type === 'EXIT' ? now : null,
        values: values || {}, gap: !!ctx.gap, ts: now,
      };
    };

    for (const p of positions) {
      const pos = _num(p.pos);
      const pset = setOf(p.station);                     // แถวของบ่อนี้
      if (p.kind === 'oven') { this._oven(st, p, pos, pset, cfg, now, events, mk, laneOf, lastBySet); continue; }   // เตาอบ (เข้า/ออกแยก tag)
      // แยก null/อ่านไม่ได้ (comms loss/ไม่มี tag) ออกจาก 0 (ว่างจริง) — null = คงสถานะเดิม กัน false "carrier ออก"
      const rawId = p.identity;
      if (rawId === null || rawId === undefined || rawId === '' || !Number.isFinite(Number(rawId))) continue;
      const nid = Number(rawId);
      let cur = st.occ[pos];

      // (a) occupant เดิมออกจากตำแหน่งนี้ (id เปลี่ยน/หาย) → STEP (บันทึก station นี้ + เวลาในบ่อ)
      if (cur && cur.carrier !== nid) {
        const jkc = pset + ':' + cur.carrier;
        const ctx = st.jobs[jkc] || { dateKey: _fmtDate(now), set: pset, lane: laneOf(p), enterTs: now, gap: true };
        const dwellS = cur.arriveTs != null ? Math.round((now - cur.arriveTs) / 1000) : null;   // dwell = วินาทีเสมอ (timeout - timein)
        const summ = _summarize(cfg, cur.params, cur.stats, cur.graph, cur.arriveTs, now);            // สรุป last/avg + min/max ตาม track
        const params = summ.values;
        const hasStats = Object.keys(summ.stats).length > 0;
        const stepEv = mk('STEP', cur.carrier, p, params, ctx);
        stepEv.enterTs = cur.arriveTs != null ? cur.arriveTs : null;   // เวลาเข้าบ่อ (timestamp ms)
        stepEv.exitTs = now;                                            // เวลาออก
        stepEv.dwell = dwellS;
        if (hasStats) stepEv.stats = summ.stats;
        const ser = _seriesOut(cur.graph, _graphKeys(cfg));   // minigraph ระหว่างชุบ (เมื่อเปิด track.graph)
        if (ser) stepEv.series = ser;
        events.push(stepEv);
        const isFinish = !!((cfg.stations || {})[String(p.station)] || {}).finish;   // จุดจบ (มีได้หลายบ่อ)
        const isLast = pos === lastBySet[pset];                         // บ่อสุดท้ายของแถวนี้
        if (isFinish || isLast) {                                       // ออกบ่อสุดท้าย/finish = "ขาออก" (done) · จบได้หลายครั้ง (จบในไลน์ → oven → จบอีก)
          const exitEv = mk('EXIT', cur.carrier, p, params, ctx);
          exitEv.enterTs = cur.arriveTs != null ? cur.arriveTs : null; exitEv.exitTs = now; exitEv.dwell = dwellS;
          if (hasStats) exitEv.stats = summ.stats;
          events.push(exitEv);
          ctx.exited = true;                                           // mark ขาออก (กลับจาก oven → running อีก · ไม่ลบจนกว่า idle-timeout)
        }
        // จำเวลา/บ่อ/ค่า unload ล่าสุด — completion (complete) คิดจาก idle-timeout: หายจากทุกบ่อเกิน N นาที (sweepIdle)
        ctx.lastExitTs = now; ctx.lastSeenTs = now; ctx.lastStation = p.station; ctx.lastParams = { ...params };
        st.jobs[jkc] = ctx;
        st.occ[pos] = null; cur = null;
      }

      // (b) มี carrier อยู่ตอนนี้
      if (nid !== 0) {
        if (!cur) {
          const jk = pset + ':' + nid;
          let ctx = st.jobs[jk];
          if (!ctx) {                                  // carrier ยังไม่อยู่ใน set/แถวนี้
            const pend = st.jobs['@:' + nid];          // มี register จากจุดเข้า (trigger) รออยู่ → materialize เข้า set จริง พร้อม barcode
            if (pend) {
              delete st.jobs['@:' + nid];
              ctx = this._startCtx(st, pset, nid, pend.enterTs, pend.lane || laneOf(p), false);   // ไม่ใช่ gap (มาจากจุดเข้าจริง)
              ctx.dateKey = pend.dateKey; ctx.enterTs = pend.enterTs;   // คงเวลา/วันที่ตอน register (ก่อนเข้าไลน์นับจากตรงนี้)
              ctx.data = { ...(pend.data || {}) };       // barcode/pattern จากจุดเข้า → ติดไป set จริง
              events.push(mk('ENTER', nid, p, ctx.data, ctx));
            } else {
              const stEntry = !!((cfg.stations || {})[String(p.station)] || {}).entry;   // บ่อนี้ตั้งเป็น "ทางเข้า"
              const isEntry = stEntry || (opts.entryMode !== 'trigger' && pos === firstBySet[pset]);   // จุดเข้าถูกต้อง (บ่อแรกของแถว/บ่อที่ตั้ง entry)
              ctx = this._startCtx(st, pset, nid, now, laneOf(p), !isEntry);   // ไม่ใช่จุดเข้า = gap
              const header = (isEntry && opts.entryMode !== 'trigger') ? (jobValues ? { ...jobValues } : {}) : {};
              ctx.data = header;                            // เก็บ job-data ใน register → entrance โชว์ได้
              events.push(mk('ENTER', nid, p, header, ctx));
            }
          } else if (ctx.exited) {                         // เคยขาออก (done) แล้วกลับเข้าบ่อ (จาก oven) → running อีกครั้ง
            ctx.exited = false;
            const re = mk('ENTER', nid, p, {}, ctx); re.reentry = true;   // reentry: ไม่รีเซ็ต enterAt/data (แค่ status→running)
            events.push(re);
          }
          if (ctx.firstBoTs == null) ctx.firstBoTs = now;   // เวลาที่เข้าบ่อแรกจริง (แยกจาก register) → คำนวณ "ก่อนเข้าไลน์"
          ctx.lastSeenTs = now; ctx.lastStation = p.station;   // เห็นในบ่อล่าสุด (รีเซ็ตนาฬิกา idle-timeout)
          st.occ[pos] = { carrier: nid, params: _latch({}, p.params), stats: _accStats({}, p.params), graph: _accSeries(null, p.params, _seriesKeys(cfg), now), arriveTs: now, set: pset };   // จับเวลาเข้าบ่อ (+set กัน carrier ซ้ำข้ามแถว)
        } else {
          _latch(cur.params, p.params);                // carrier เดิมยังอยู่ → latch param
          cur.stats = _accStats(cur.stats || {}, p.params);   // + สะสม min/max/avg ทุก poll
          cur.graph = _accSeries(cur.graph, p.params, _seriesKeys(cfg), now);   // + minigraph (throttle ~5s)
          const ctx = st.jobs[pset + ':' + nid];       // อัปเดตเวลาเห็นล่าสุด (กัน idle-timeout จบทั้งที่ยังอยู่บ่อ)
          if (ctx) { ctx.lastSeenTs = now; ctx.lastStation = p.station; }
        }
      }
    }
    return events;
  }

  // idle-timeout completion — job ที่ "หายจากทุกบ่อ" นานเกิน timeoutMs = จบสมบูรณ์
  //   นับเวลาจาก unload ล่าสุด (lastExitTs) · รองรับจบหลายครั้ง (ไป oven แล้วกลับมาในเวลา = ยังไม่จบ)
  //   register-only (ยังไม่เคยเข้าบ่อ) = ไม่ auto-complete (ปล่อยให้รอเข้าไลน์ต่อ)
  sweepIdle(line, cfg, now, timeoutMs) {
    now = now || Date.now();
    cfg = cfg || {};
    const st = this.state[line];
    if (!st || !st.jobs) return [];
    const to = Number(timeoutMs) || 0;
    if (to <= 0) return [];
    const occ = new Set();                         // (set:carrier) ที่ยังอยู่ในบ่อตอนนี้
    for (const pos in st.occ) { const o = st.occ[pos]; if (o && o.carrier != null) occ.add((o.set != null ? o.set : '1') + ':' + o.carrier); }
    const ovenCarriers = new Set();                // carrier ที่อยู่ในเตาอบ (ข้าม set) = ยังอยู่ในระบบ ไม่ complete
    for (const stn in (st.oven || {})) { for (const cr in ((st.oven[stn] || {}).c || {})) ovenCarriers.add(String(cr)); }
    const events = [];
    for (const jk of Object.keys(st.jobs)) {
      if (occ.has(jk)) continue;                    // ยังอยู่ในบ่อ → ไม่จบ
      const ctx = st.jobs[jk];
      if (ctx.lastSeenTs == null && ctx.lastExitTs == null) continue;   // ยังไม่เคยเข้าบ่อ (รอเข้าไลน์) — ข้าม
      if (ovenCarriers.has(jk.slice(jk.indexOf(':') + 1))) continue;    // กำลังอบใน oven → ยังอยู่ในระบบ ไม่จบ
      const ref = ctx.lastExitTs != null ? ctx.lastExitTs : ctx.lastSeenTs;
      if (now - ref <= to) continue;                // ยังหายไม่ครบเวลา
      const i = jk.indexOf(':');
      const carrier = i >= 0 ? jk.slice(i + 1) : jk;
      const s = (cfg.stations || {})[String(ctx.lastStation)] || {};
      events.push({
        line, type: 'EXIT', carrier: String(carrier), lane: ctx.lane || '', dateKey: ctx.dateKey,
        set: ctx.set, run: ctx.run != null ? ctx.run : null,
        station: ctx.lastStation != null ? String(ctx.lastStation) : '', stationName: s.name || '', stationType: s.type || '', seq: s.seq != null ? Number(s.seq) : null,
        enterTs: ctx.enterTs || null, exitTs: ref, values: ctx.lastParams || {}, gap: !!ctx.gap, ts: ref, complete: true,
      });
      delete st.jobs[jk];                           // จบแล้ว → ออกจาก register
    }
    return events;
  }

  // migration ตอน load (restart) — register รุ่นเก่า (ผูก set ตั้งแต่ register · barcode อาจหายเมื่อเข้าบ่อคนละ set)
  //   → register-only ที่ยังไม่เข้าบ่อ = แปลงเป็น pending (รอ materialize set จริง) · ที่เข้าบ่อคนละ set แล้ว = ย้าย barcode เข้า ctx ที่วิ่งอยู่
  migrateRegistersToPending(line) {
    const st = this.state[line];
    if (!st || !st.jobs) return;
    const running = {};                              // nid → key ของ ctx ที่เคยเข้าบ่อแล้ว (firstBoTs != null)
    for (const k of Object.keys(st.jobs)) {
      if (k.startsWith('@:')) continue;
      const ctx = st.jobs[k];
      if (ctx && ctx.firstBoTs != null) running[k.slice(k.indexOf(':') + 1)] = k;
    }
    for (const k of Object.keys(st.jobs)) {
      if (k.startsWith('@:')) continue;
      const ctx = st.jobs[k];
      if (!ctx || ctx.firstBoTs != null || ctx.pending) continue;   // เฉพาะ register-only เก่า
      const nid = k.slice(k.indexOf(':') + 1);
      const rk = running[nid];
      if (rk && rk !== k) {                          // carrier เข้าบ่อ (คนละ set) แล้ว → เติม barcode ที่ขาดเข้า ctx ที่วิ่งอยู่
        const r = st.jobs[rk];
        r.data = { ...(ctx.data || {}), ...(r.data || {}) };
        delete st.jobs[k];
      } else if (!st.jobs['@:' + nid]) {             // ยังไม่เข้าบ่อ → pending (รอ materialize set จริง พร้อม barcode)
        st.jobs['@:' + nid] = { pending: true, set: null, lane: ctx.lane || '', dateKey: ctx.dateKey, enterTs: ctx.enterTs, firstBoTs: null, data: ctx.data || {}, gap: false };
        delete st.jobs[k];
      } else {
        delete st.jobs[k];
      }
    }
  }
}

module.exports = { CarrierTracker, _fmtDate, _latch, _accStats, _summarize, _accSeries, _seriesOut, _graphKeys, _seriesKeys, _midOf };
