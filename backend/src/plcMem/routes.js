// plcMem/routes.js — mountPlcMem(app, manager, helpers): REST ทั้งหมดของ PLCMEM
//   ไม่ใช้ express.Router (idiom mountLineRecorder — server.js:244) · response shape {ok:...} (gotcha #9)
//   helpers = { resolveActor, logActivity } ฉีดมาจาก server.js (routes.js เป็นโมดูลแยก ไม่เห็น function ภายใน server.js เอง)
//   T1: GET/PUT /api/plcmem (config+status) · T4: sweep trigger/buffer read/buffer2 write+audit/diff
//   write จริง (T5) + snapshot (T6) + kpenetwork (T8) เพิ่มทีหลัง
const { AREAS } = require('./constants');
const { validateBuffer2Rows } = require('./validateBuffer2');

function mountPlcMem(app, manager, helpers = {}) {
  // fallback เผื่อเทส/เรียกตรงไม่ได้ฉีด helpers มา — ไม่ throw แต่ actor จะเป็น guest เสมอ
  const resolveActor = typeof helpers.resolveActor === 'function'
    ? helpers.resolveActor
    : (_req) => ({ actor: 'guest', actorType: 'guest', ip: '' });
  const logActivity = typeof helpers.logActivity === 'function' ? helpers.logActivity : () => {};

  const findPlc = (dev) => manager.getConfig().plcs.find((p) => p.deviceId === dev);

  // ── T1: config ──────────────────────────────────────────────────────────
  app.get('/api/plcmem', (_req, res) => {
    res.json({ ok: true, config: manager.getConfig(), status: manager.getStatus() });
  });

  app.put('/api/plcmem', (req, res) => {
    try {
      const config = manager.updateConfig(req.body || {});
      res.json({ ok: true, config });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── T4: trigger กวาดทันที {ranges?} — 409 ถ้ากำลังกวาด/plc ไม่ได้ทำงานอยู่ ────────
  //   review finding #9: เดิม route นี้ไม่ resolveActor/logActivity/journal เลย ต่างจาก mutating
  //   route อื่นทุกตัวของ PLCMEM (buffer2/write/backup/rollback) — เพิ่มให้ตรงกัน (audit ให้ครบ)
  app.post('/api/plcmem/:dev/sweep', async (req, res) => {
    const dev = req.params.dev;
    const plc = findPlc(dev);
    if (!plc) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    const { actor, actorType, ip } = resolveActor(req);
    try {
      const body = req.body || {};
      const ranges = Array.isArray(body.ranges) && body.ranges.length ? body.ranges : undefined;
      // names: เลือกกวาดเฉพาะช่วงที่ตั้งไว้ตามชื่อ (ไม่ส่ง = กวาดครบทุกช่วง) — ดู manager.resolveRanges()
      const names = Array.isArray(body.names) && body.names.length ? body.names : undefined;
      const result = await manager.sweepNow(dev, { ranges, names });
      const scope = names ? `ช่วง ${names.join(',')}` : (ranges ? 'ช่วงที่ระบุเอง' : 'ทุกช่วง');
      try {
        await manager.store.journal(plc.bufferConn, {
          plc: dev, action: 'sweep_trigger', detail: `manual sweep (${scope}): ok ${result.okChunks} · err ${result.errChunks}`, actor, actorType, ip,
        });
      } catch (_) {}
      logActivity(req, { category: 'data', action: 'plcmem_sweep', target: dev, detail: `ok ${result.okChunks} · err ${result.errChunks}` });
      res.json({ ok: true, result });
    } catch (e) {
      if (e.code === 'BUSY' || e.code === 'NOT_RUNNING') return res.status(409).json({ ok: false, error: e.message });
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── T4: อ่าน buffer แบ่งหน้า (cap 5000/ครั้ง — บังคับที่นี่อีกชั้นนอกจาก store) ──────
  app.get('/api/plcmem/:dev/buffer', async (req, res) => {
    const dev = req.params.dev;
    const plc = findPlc(dev);
    if (!plc) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const area = String(req.query.area || '').toUpperCase();
      if (!AREAS.includes(area)) return res.status(400).json({ ok: false, error: `area ต้องเป็นหนึ่งใน ${AREAS.join(',')}` });
      const buf = req.query.buf === '2' ? 2 : 1;
      const from = req.query.from != null && req.query.from !== '' ? Number(req.query.from) : null;
      const to = req.query.to != null && req.query.to !== '' ? Number(req.query.to) : null;
      const nonzero = req.query.nonzero === '1' || req.query.nonzero === 'true';
      const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rows = await manager.store.readRange(plc.bufferConn, plc.deviceId, buf, area, from, to, { nonzero, limit, offset });
      res.json({ ok: true, rows });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── T4: เขียนค่าเข้า buffer02 {values:[{area,addr,value}]} + audit ────────────────
  //   §C8/§A: actor/ip resolve ฝั่ง server เสมอ (ห้ามรับจาก body — anti-spoof)
  app.put('/api/plcmem/:dev/buffer2', async (req, res) => {
    const dev = req.params.dev;
    const plc = findPlc(dev);
    if (!plc) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const { actor, actorType, ip } = resolveActor(req);
      const rows = validateBuffer2Rows(req.body && req.body.values, actor);
      const result = await manager.store.upsertBatch(plc.bufferConn, plc.deviceId, 2, rows);
      await manager.store.journal(plc.bufferConn, {
        plc: dev, action: 'buffer2_write', detail: `${rows.length} address`, actor, actorType, ip,
      });
      logActivity(req, { category: 'data', action: 'plcmem_buffer2_write', target: dev, detail: `${rows.length} address` });
      res.json({ ok: true, upserted: result.upserted });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── T5: เขียน PLC จริง {confirm:true} — จุดเสี่ยงสุด ดูลำดับเต็มใน writer.js ──────────
  app.post('/api/plcmem/:dev/write', async (req, res) => {
    const dev = req.params.dev;
    if (!findPlc(dev)) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const confirm = (req.body || {}).confirm === true;
      const actorCtx = resolveActor(req);
      const result = await manager.write(dev, { confirm }, actorCtx);
      logActivity(req, {
        category: 'data', action: 'plcmem_write', target: dev,
        detail: result.ok ? `written ${result.written} word` : `FAILED @${result.failedAt && result.failedAt.area}${result.failedAt && result.failedAt.start}: ${result.error}`,
        result: result.ok ? 'ok' : 'fail',
      });
      res.json(result);   // {ok:true,written,runs} หรือ {ok:false,wrote,failedAt,verified,error} — ทั้งคู่เป็นผลลัพธ์งานปกติ ไม่ใช่ request error
    } catch (e) {
      if (e.code === 'GATE_CLOSED' || e.code === 'NOT_RUNNING' || e.code === 'NOT_CONNECTED') {
        return res.status(409).json({ ok: false, error: e.message });
      }
      res.status(400).json({ ok: false, error: e.message });   // เช่น NEED_CONFIRM
    }
  });

  // ── T4: diff buf2(อยากได้) ↔ buf1(ล่าสุดจริง) — จับกลุ่ม contiguous run ให้ด้วย ─────
  app.get('/api/plcmem/:dev/diff', async (req, res) => {
    const dev = req.params.dev;
    const plc = findPlc(dev);
    if (!plc) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const diff = await manager.store.diff(plc.bufferConn, plc.deviceId);
      const runs = manager.store.groupRuns(diff, plc.writeMaxWords);
      res.json({ ok: true, diff, runs });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── T6: snapshot (cold path) — backup/rollback/list/delete ───────────────────────
  app.get('/api/plcmem/:dev/snapshots', async (req, res) => {
    const dev = req.params.dev;
    if (!findPlc(dev)) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const snapshots = await manager.listSnapshots(dev);
      res.json({ ok: true, snapshots });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/plcmem/:dev/backup', async (req, res) => {
    const dev = req.params.dev;
    if (!findPlc(dev)) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const { actor, actorType, ip } = resolveActor(req);
      const note = String((req.body && req.body.note) || '');
      const result = await manager.backup(dev, note, { actor, actorType, ip });
      logActivity(req, { category: 'data', action: 'plcmem_backup', target: dev, detail: `${result.snapTable} (${result.count} row)` });
      res.json({ ok: true, snapshot: result });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // rollback เทเข้า buffer02 เท่านั้น — ไม่แตะ PLC (user กดเขียนเองที่ POST .../write อีกที)
  app.post('/api/plcmem/:dev/rollback', async (req, res) => {
    const dev = req.params.dev;
    if (!findPlc(dev)) return res.status(404).json({ ok: false, error: `plc "${dev}" ไม่มีใน config` });
    try {
      const snapId = (req.body || {}).snapId;
      if (snapId == null) throw new Error('snapId required');
      const { actor, actorType, ip } = resolveActor(req);
      const result = await manager.rollback(dev, snapId, { actor, actorType, ip });
      logActivity(req, { category: 'data', action: 'plcmem_rollback', target: dev, detail: `snapshot #${snapId} → buffer02 (${result.restored} address)` });
      res.json(result);
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/plcmem/snapshots/:snapId', async (req, res) => {
    try {
      const actorCtx = resolveActor(req);
      const result = await manager.deleteSnapshot(req.params.snapId, actorCtx);
      logActivity(req, { category: 'data', action: 'plcmem_snapshot_delete', target: String(req.params.snapId), detail: result.snapTable || '' });
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: e.message });
      res.status(400).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mountPlcMem };
