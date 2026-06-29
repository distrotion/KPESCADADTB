// routes.js — mount REST API ของ Line Recorder เข้า express app (เรียกครั้งเดียวจาก server.js)
//   auth/token middleware ของ app ครอบให้อยู่แล้ว (เหมือน /api/stock)
function mountLineRecorder(app, manager) {
  const se = (res, e) => res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });

  app.get('/api/line-recorder/lines', (_req, res) => { const lines = manager.listLines(); res.json({ ok: true, lines, count: lines.length, maxLines: manager.maxLines() }); });
  app.get('/api/line-recorder/lines/:line/config', (req, res) => {
    const c = manager.getConfig(req.params.line); if (!c) return res.status(404).json({ ok: false, error: 'ไม่พบไลน์' });
    res.json({ ok: true, config: c });
  });
  app.post('/api/line-recorder/reload', (_req, res) => res.json({ ok: true, lines: manager.reload() }));

  // สร้างตาราง (per-line) บน DB ของไลน์ — ปุ่ม "สร้างตาราง"
  app.post('/api/line-recorder/lines/:line/ensure-schema', async (req, res) => {
    try { await manager.ensureSchema(req.params.line); res.json({ ok: true }); } catch (e) { se(res, e); }
  });
  // reset — archive ตารางเดิม (ใส่วันเวลา) + เริ่มข้อมูลใหม่ (lock คงเดิม)
  app.post('/api/line-recorder/lines/:line/reset', async (req, res) => {
    try {
      const d = new Date(); const p = (x) => String(x).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const ts = await manager.resetLine(req.params.line, stamp);
      res.json({ ok: true, archivedAs: ts });
    } catch (e) { se(res, e); }
  });

  // สร้าง/แก้/ตั้งชื่อไลน์เอง (body = config: line, label, decode, events, stations, fields…) → เก็บ runtime
  app.post('/api/line-recorder/lines', (req, res) => {
    try { const cfg = manager.saveLine(req.body || {}); res.json({ ok: true, config: cfg }); }
    catch (e) {
      if (e && e.code === 'line-limit') return res.status(403).json({ ok: false, error: 'line-limit', maxLines: e.maxLines, current: e.current });
      se(res, e);
    }
  });
  app.delete('/api/line-recorder/lines/:line', (req, res) => {
    try { res.json({ ok: manager.deleteLine(req.params.line) }); } catch (e) { se(res, e); }
  });

  // comment ต่อแถว (set) — แก้จากหน้า monitor · body { set, note }
  app.post('/api/line-recorder/lines/:line/set-note', (req, res) => {
    try { const b = req.body || {}; res.json({ ok: true, setNotes: manager.setSetNote(req.params.line, b.set, b.note) }); } catch (e) { se(res, e); }
  });
  // comment field (manual job-field) รายแถว — body { jobKey?, carrier?, set?, key, value }
  app.post('/api/line-recorder/lines/:line/comment', async (req, res) => {
    try { res.json(await manager.setComment(req.params.line, req.body || {})); } catch (e) { se(res, e); }
  });
  // ยกเลิกมือ — carrier ค้างในเตา (เข้าเตาแต่ไม่มีเลขออก) → บันทึก manual cancel — body { station, carrier }
  app.post('/api/line-recorder/lines/:line/oven-cancel', async (req, res) => {
    try { const b = req.body || {}; res.json(await manager.cancelOven(req.params.line, b.station, b.carrier)); } catch (e) { se(res, e); }
  });

  app.get('/api/line-recorder/jobs', async (req, res) => {
    try { res.json({ ok: true, jobs: await manager.jobs({ line: req.query.line || null, dateKey: req.query.date || null, status: req.query.status || null, q: req.query.q || null, from: req.query.from ? Number(req.query.from) : null, to: req.query.to ? Number(req.query.to) : null, limit: Number(req.query.limit) || 200 }) }); } catch (e) { se(res, e); }
  });
  app.get('/api/line-recorder/jobs/:jobKey', async (req, res) => {
    try { const j = await manager.job(decodeURIComponent(req.params.jobKey)); if (!j) return res.status(404).json({ ok: false, error: 'ไม่พบ job' }); res.json({ ok: true, job: j }); } catch (e) { se(res, e); }
  });
  app.get('/api/line-recorder/events', async (req, res) => {
    try { res.json({ ok: true, events: await manager.events({ line: req.query.line || null, limit: Number(req.query.limit) || 200 }) }); } catch (e) { se(res, e); }
  });

  // ingest (ทดสอบ/จำลอง PLC · mode=tag/array) — body: { line, raw:[...], ts? }
  app.post('/api/line-recorder/ingest', async (req, res) => {
    try { const b = req.body || {}; res.json({ ok: true, ...(await manager.ingest(b.line, b.raw, b.ts)) }); } catch (e) { se(res, e); }
  });

  // snapshot (ทดสอบ/จำลองไลน์เดิน · mode=snapshot) — body: { line, snapshot:[{pos,station,identity,params}], ts? }
  //   ป้อน snapshot ทีละจังหวะ → CarrierTracker diff → project · คืน events ที่สังเคราะห์ + state
  app.post('/api/line-recorder/snapshot', async (req, res) => {
    try {
      const b = req.body || {};
      const cfg = manager.getConfig(b.line);
      if (!cfg) return res.status(404).json({ ok: false, error: 'ไม่พบไลน์' });
      const events = manager.tracker.update(b.line, b.snapshot || [], cfg, b.ts || Date.now());
      const results = [];
      for (const ev of events) results.push(await manager.projectEvent(ev));
      res.json({ ok: true, events, state: manager.tracker.snapshotState(b.line) });
    } catch (e) { se(res, e); }
  });
  // ล้าง state tracker ของไลน์ (เริ่มจำลองใหม่)
  app.post('/api/line-recorder/snapshot/reset', (req, res) => {
    try { manager.tracker.reset((req.body || {}).line || null); res.json({ ok: true }); } catch (e) { se(res, e); }
  });

  // monitor ผังบ่อสด — recorder: RAM สด · viewer: อ่าน lr_register จาก DB (ของ recorder) + lock status
  app.get('/api/line-recorder/state', async (req, res) => {
    try {
      const line = req.query.line;
      if (!line) return res.status(400).json({ ok: false, error: 'ต้องระบุ line' });
      const state = await manager.stateFor(line);
      let lock = null; try { lock = await manager.lockStatus(line); } catch (_) {}
      res.json({ ok: true, state, lock });
    } catch (e) { se(res, e); }
  });

  // ── Recorder lock (HA) ──
  app.get('/api/line-recorder/lines/:line/lock', async (req, res) => {
    try { res.json({ ok: true, lock: await manager.lockStatus(req.params.line) }); } catch (e) { se(res, e); }
  });
  app.post('/api/line-recorder/lines/:line/promote', async (req, res) => {   // ยึดเป็นตัวบันทึก (manual takeover)
    try { res.json({ ok: true, amOwner: await manager.promote(req.params.line) }); } catch (e) { se(res, e); }
  });
  app.post('/api/line-recorder/lines/:line/release', async (req, res) => {   // ปล่อยการบันทึก (graceful)
    try { res.json({ ok: await manager.release(req.params.line) }); } catch (e) { se(res, e); }
  });
  // identity/role ของเครื่องนี้ (per-machine)
  app.get('/api/line-recorder/identity', (_req, res) => res.json({ ok: true, identity: manager.getIdentity() }));
  app.post('/api/line-recorder/identity/role', (req, res) => {
    try { res.json({ ok: true, role: manager.setRole((req.body || {}).role) }); } catch (e) { se(res, e); }
  });
}

module.exports = { mountLineRecorder };
