'use strict';
const path = require('path');
// Glue between MeshCenter and the running backend: HTTP routes, the MESH managed device (tags),
// automatic datalog + alarm, and activity-log events. Everything is off unless mesh.json enables it.
const { MeshCenter } = require('./meshCenter');
const { loadMeshConfig, saveMeshConfig, publicMeshConfig } = require('./meshConfig');
const { makeStatsReader, makeRelayFactory, makeBootStore } = require('./meshWiring');

const HTTP = { 'bad-request': 400, 'no-key': 503, 'bad-hmac': 401, 'clock-skew': 400, replay: 409, 'rate-limit': 429, 'too-large': 413 };
const tagId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
// silentMin is published in 0.1-min steps and sits on the setpoint for a few seconds; AlarmEngine keeps a 'hi' alarm only while
// value > setpoint - deadband, so with 0 it flapped raise/clear every second (testbed drill B). One step of hysteresis stops that.
const SILENT_DEADBAND_MIN = 0.1;

function cachedConfig(loader, ttlMs = 2000, now = Date.now) {
  let at = 0; let val = null;
  return () => { const t = now(); if (!val || t - at > ttlMs) { val = loader(); at = t; } return val; };
}

function mountMeshRoutes(app, center, { getConfig, log = () => {} }) {
  app.post('/api/kpenetwork/witness', (req, res) => {
    const ce = (getConfig() || {}).center || {};
    if (!ce.enabled) return res.status(503).json({ ok: false, code: 'disabled', message: 'mesh centre is not enabled on this node' });
    // a real report (<= 64 stations) is a few KB; the app-wide body parser allows far more, and signing walks the whole body
    if (Number(req.headers['content-length'] || 0) > 65536) return res.status(413).json({ ok: false, code: 'too-large', message: 'witness report too large' });
    const r = center.ingest(req.body);
    if (r.ok) return res.json(r);
    log(`[mesh] report rejected (${r.code}): ${r.message}`);
    return res.status(HTTP[r.code] || 400).json(r);
  });
  // kpelink repair: what reporters see of the machines they watch (separate from the witness report so older centres keep working)
  app.post('/api/kpenetwork/services', (req, res) => {
    const ce = (getConfig() || {}).center || {};
    if (!ce.enabled) return res.status(503).json({ ok: false, code: 'disabled', message: 'mesh centre is not enabled on this node' });
    if (Number(req.headers['content-length'] || 0) > 16384) return res.status(413).json({ ok: false, code: 'too-large', message: 'services report too large' });
    const r = center.ingestServices(req.body);
    if (r.ok) return res.json(r);
    log(`[mesh] services report rejected (${r.code}): ${r.message}`);
    return res.status(HTTP[r.code] || 400).json(r);
  });
  app.get('/api/kpenetwork/liveness', (_req, res) => res.json({ ok: true, ...center.liveness() }));
  app.get('/api/kpenetwork/mesh-config', (_req, res) => res.json({ ok: true, config: publicMeshConfig(getConfig()) }));
  app.put('/api/kpenetwork/mesh-config', (req, res) => {
    try { res.json({ ok: true, config: publicMeshConfig(saveMeshConfig(req.body || {})) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

// one pass: publish tags, make sure the datalog/alarm exist, log state transitions
function makeTick({ center, engine, datalogManager, alarmEngine, activityLog, getConfig, log = () => {} }) {
  return function tick() {
    const ce = (getConfig() || {}).center || {};
    if (!ce.enabled) return null;
    const live = center.liveness();
    const ids = Object.keys(live.stations);
    const svcIds = Object.keys(live.services || {});
    if (engine && (ids.length || svcIds.length)) {
      const tags = [];
      for (const id of svcIds) {
        const t = tagId(id);
        tags.push({ id: `${t}_svc_state`, name: `${id} services: 0 down or unreachable (2+ reporters), 1 suspect, 2 up`, dataType: 'INT' },
                  { id: `${t}_svc_down_min`, name: `${id}: minutes confirmed down or unreachable`, dataType: 'REAL', unit: 'min' });
      }
      for (const id of ids) {
        const t = tagId(id);
        tags.push({ id: `${t}_state`, name: `${id}: 0 silent, 1 witnessed, 2 direct`, dataType: 'INT' },
                  { id: `${t}_witness`, name: `${id}: heard by a neighbour`, dataType: 'INT' },
                  { id: `${t}_unsent`, name: `${id}: rows waiting to upload`, dataType: 'INT' },
                  { id: `${t}_silent_min`, name: `${id}: minutes silent on every route`, dataType: 'REAL', unit: 'min' });
      }
      try { engine.registerManagedDevice({ id: 'MESH', name: 'Mesh liveness', tags }); } catch (e) { log('[mesh] register device: ' + e.message); }
      for (const id of svcIds) {
        const v = live.services[id]; const t = tagId(id);
        try { engine.setTagValue('MESH', `${t}_svc_state`, v.stateNum, 'good'); engine.setTagValue('MESH', `${t}_svc_down_min`, v.downMin, 'good'); } catch (_) { /* not registered yet */ }
      }
      for (const id of ids) {
        const s = live.stations[id]; const t = tagId(id);
        const set = (k, v) => { try { engine.setTagValue('MESH', `${t}_${k}`, v, 'good'); } catch (_) { /* tag not registered yet */ } };
        set('state', s.stateNum); set('witness', s.state === 'witnessed' ? 1 : 0);
        set('unsent', s.unsent == null ? -1 : s.unsent); set('silent_min', s.silentMin);
      }
    }
    for (const id of ids) {
      const t = tagId(id);
      if (ce.autoDatalog !== false && datalogManager) {
        const name = `MESH ${id} state`;
        try {
          if (!(datalogManager.logs || []).some((l) => l.name === name)) {
            datalogManager.create({ name, group: 'MESH', storage: 'csv', periodic: false, onChange: true, retentionDays: 90,
              series: [{ device: 'MESH', tag: `${t}_state`, label: id }] });
          }
        } catch (e) { log(`[mesh] datalog ${id}: ${e.message}`); }
      }
      if (ce.autoAlarm !== false && alarmEngine) {
        const aid = `mesh_silent_${t}`; const sp = Number(ce.silentAlarmMin) || 10;
        // a station that is switched off every day (a weighing cart) can opt out: center.stations.<ST>.silentAlarm = false
        const wanted = !((ce.stations || {})[id] && ce.stations[id].silentAlarm === false);
        try {
          const def = (alarmEngine.defs || []).find((d) => d.id === aid);
          if (!wanted) { if (def) { alarmEngine.removeAlarm(aid); log(`[mesh] silent alarm for ${id} removed (silentAlarm: false)`); } }
          else if (!def) {
            alarmEngine.addAlarm({ id: aid, name: `Station silent: ${id}`, type: 'limit', subType: 'hi', deviceId: 'MESH', tagId: `${t}_silent_min`,
              setpoint: sp, deadband: SILENT_DEADBAND_MIN, onDelaySec: 0, offDelaySec: 0, priority: 'high', group: 'MESH',
              message: `${id} is unreachable on every route (direct and through neighbours)` });
          } else if (def.setpoint !== sp || Number(def.deadband) !== SILENT_DEADBAND_MIN) alarmEngine.updateAlarm(aid, { setpoint: sp, deadband: SILENT_DEADBAND_MIN });
        } catch (e) { log(`[mesh] alarm ${id}: ${e.message}`); }
      }
    }
    // kpelink repair: "Service down: <machine>" once two or more reporters have seen it down or unreachable for serviceAlarmMin
    // (down: the peers may already be repairing it · unreachable: nothing answers at all, which nobody can repair from the network)
    if (ce.autoAlarm !== false && alarmEngine) {
      for (const id of svcIds) {
        const t = tagId(id); const aid = `mesh_svcdown_${t}`; const sp = Number(ce.serviceAlarmMin) || 5;
        try {
          const def = (alarmEngine.defs || []).find((d) => d.id === aid);
          if (!def) {
            alarmEngine.addAlarm({ id: aid, name: `Service down: ${id}`, type: 'limit', subType: 'hi', deviceId: 'MESH', tagId: `${t}_svc_down_min`,
              setpoint: sp, deadband: SILENT_DEADBAND_MIN, onDelaySec: 0, offDelaySec: 0, priority: 'high', group: 'MESH',
              message: `${id}: down or unreachable as seen by two or more machines (if a service is down, kpelink repair may be restarting it)` });
          } else if (def.setpoint !== sp || Number(def.deadband) !== SILENT_DEADBAND_MIN) alarmEngine.updateAlarm(aid, { setpoint: sp, deadband: SILENT_DEADBAND_MIN });
        } catch (e) { log(`[mesh] service alarm ${id}: ${e.message}`); }
      }
    }
    for (const tr of center.transitions(live)) {
      try { activityLog && activityLog.log({ category: 'system', action: 'mesh_state', target: tr.station, detail: `${tr.from || 'new'} -> ${tr.to}`, user: 'mesh', actorType: 'system', result: 'ok' }); } catch (_) { /* logging must never break the tick */ }
    }
    return live;
  };
}

function startMeshCenter({ app, engine, datalogManager, alarmEngine, activityLog, getConfig, log = console.log, tickMs = 5000, now }) {
  const cfg = getConfig || cachedConfig(loadMeshConfig);
  const center = new MeshCenter({
    getConfig: cfg, now,
    readTag: (d, t) => { const v = engine && engine.getTagValue(d, t); return v ? v.value : null; },
  });
  mountMeshRoutes(app, center, { getConfig: cfg, log });
  const tick = makeTick({ center, engine, datalogManager, alarmEngine, activityLog, getConfig: cfg, log });
  const timer = setInterval(() => { try { tick(); } catch (e) { log('[mesh] tick: ' + e.message); } }, tickMs);
  if (timer.unref) timer.unref();
  return { center, tick, stop: () => clearInterval(timer) };
}

// The Pi side of the mesh: beacon + neighbour table + witness reports. Off unless mesh.json enables node.
function startMeshNode({ app, engine, dbManager, getConfig, log = console.log, helper, post, clockOk, peerTime, bootStore, repairConfig, syncMs = 5000 }) {
  const { MeshNode } = require('./meshNode');
  const { BleHelper } = require('./bleHelper');
  const { PeerWatch } = require('./peerWatch');
  const cfg = getConfig || cachedConfig(loadMeshConfig);
  // kpelink repair: this machine's repair key + name live in the Manager's peer-repair.json (0600), never in mesh.json
  const readRepair = repairConfig || cachedConfig(() => {
    const fs = require('fs');
    // same places the Manager reads it from (mgrReadCfg): the data dir first, then next to the Manager's source
    const files = [path.join(__dirname, '..', '..', '..', 'manager', 'peer-repair.json')];
    if (process.env.KPE_DATA_DIR) files.unshift(path.join(process.env.KPE_DATA_DIR, 'config', 'manager', 'peer-repair.json'));
    for (const file of files) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* next */ } }
    return null;
  }, 10000);
  let node = null;
  const watch = new PeerWatch({ getConfig: cfg, readRepair, log, myNetworkOk: () => !!(node && node.networkOkForVoting()) });
  node = new MeshNode({
    getConfig: cfg, log, post, clockOk, peerTime, serviceReport: () => watch.reportEntries(), helper: helper || new BleHelper({ log }), bootStore: bootStore === undefined ? makeBootStore(path.join(require('../csvUtil').configDir(), 'mesh-state.json')) : bootStore, relayFactory: makeRelayFactory({ dbManager, getConfig: cfg }),
    readTag: (d, t) => { const v = engine && engine.getTagValue(d, t); return v ? v.value : null; },
    readStats: makeStatsReader({ dbManager, getConfig: cfg }),
  });
  app.get('/api/kpenetwork/mesh-neighbors', async (_req, res) => {
    const out = { ok: true, ...node.status(), watch: watch.status() };
    if (node.relay) { try { out.relay = await node.relay.status(); } catch (e) { out.relay = { error: e.message }; } }
    res.json(out);
  });
  // switching node.enabled in mesh.json (or PUT /api/kpenetwork/mesh-config) takes effect within seconds, no restart
  const sync = () => {
    const on = !!((cfg() || {}).node || {}).enabled;
    if (on && !node.running) node.start(); else if (!on && node.running) { node.stop(); log('[mesh] node stopped (disabled)'); }
  };
  sync();
  const timer = setInterval(() => { try { sync(); } catch (e) { log('[mesh] node sync: ' + e.message); } }, syncMs);
  if (timer.unref) timer.unref();
  // watching other machines runs on its own clock (it does not need Bluetooth); it only works while node.enabled and node.watch are set
  const watchTimer = setInterval(() => { watch.tick().catch((e) => log('[mesh] watch: ' + e.message)); }, watch._cfg().everyMs || 30000);
  if (watchTimer.unref) watchTimer.unref();
  return { node, watch, sync, stop: () => { clearInterval(timer); clearInterval(watchTimer); node.stop(); } };
}

module.exports = { startMeshCenter, startMeshNode, makeStatsReader, makeRelayFactory, mountMeshRoutes, makeTick, cachedConfig, tagId };
