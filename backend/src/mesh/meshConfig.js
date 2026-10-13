'use strict';
// config/mesh.json - one file for both roles. Default = everything off, so an installation that
// never configures it behaves exactly as before.
const fs = require('fs');
const path = require('path');
const csv = require('../csvUtil');
const { keyStrongEnough } = require('./meshCrypto');

const DEFAULTS = {
  key: '',                                   // shared secret of the plant: generated, >= 32 hex chars (openssl rand -hex 16); empty = mesh rejects everything
  center: {
    enabled: false,
    ttlSec: 60,                              // a witness report keeps a station "witnessed" this long (300 kept a switched-off cart "alive" for 5 min)
    maxSkewSec: 300,                         // reject reports whose clock is further off than this
    minIntervalSec: 2,                       // per-reporter rate limit
    silentAlarmMin: 10,                      // alarm when a station is silent on every route this long
    serviceAlarmMin: 5,                      // kpelink repair: alarm when a watched machine is down (2+ reporters) this long
    autoAlarm: true,
    autoDatalog: true,
    stations: {},                            // { "W190": { "onlineTag": "W190/__online" }, "W187": { "onlineTag": "...", "silentAlarm": false } }
  },
  node: {
    enabled: false,
    station: '',                             // this station's id in the mesh, e.g. "W190"
    stationNum: 0,                           // 1..65534 number used in beacons (must be unique in the plant)
    centerUrl: '',                           // e.g. "http://172.23.10.32:10000"
    centerUrls: [],                          // more than one centre: reports go to every one of them (centerUrl is added to this list)
    // "can this station deliver its data" measured directly (TCP connect, e.g. the database server .39:1433) instead of onlineTag;
    // another machine being down must not make every station believe its own network is down. Offline only after failAfter misses in a row.
    onlineProbe: { host: '', port: 0, everySec: 10, timeoutMs: 3000, failAfter: 3 },
    reportSec: 15,                           // witness report to the centre (only while the centre is reachable)
    advMs: 5000,                             // how often the beacon counter is refreshed (min 2000)
    scanOnSec: 2,                            // BLE scan window; scanDuty decides how long the pause after it is (2 s / 8 s = 20 %)
    scanDuty: 0.2,                           // 0.02..1 - share of time spent scanning (BT shares the 2.4 GHz radio with WiFi)
    aliveSec: 30,                            // a neighbour whose counter has not advanced for this long is not alive
    statsSec: 30,                            // how often the "rows waiting" numbers are read
    stats: { db: '', unsentSql: '', lastRecordSql: '' },   // e.g. db 'DATA', 'SELECT COUNT(*) AS n FROM kubotalog_backup WHERE sent=0', 'SELECT ts FROM kubotalog_backup ORDER BY id DESC LIMIT 1'
    testIgnoreSids: [],                      // lab only: pretend these stations cannot be heard (builds a multi-hop topology on a bench)
    onlineTag: '',                           // "dev/tag": is the centre reachable
    recordingTag: '',                        // "dev/tag": can this station record
    peers: {},                               // { "W185": 185, ... } station -> stationNum of the others
    // kpelink repair (docs/PEER-REPAIR-PLAN.md): machines this node watches from the outside and votes to repair:
    // [{ "name": "W186", "front": "http://172.26.20.186:3012", "manager": "http://172.26.20.186:5012" }] - the repair key is in the Manager's peer-repair.json
    watch: [], watchEverySec: 30, voteAfterSec: 120, voteEverySec: 60,
    peerTime: {                              // clock from neighbours (meshTime.js): only when the time master is unreachable and there is no recent verified sync
      enabled: true, staleHours: 6, intervalSec: 60, agreeMs: 2000, maxPeers: 2,
    },
    relay: {                                 // hand weigh rows to a neighbour while this station has no network (docs/MESH-NODE.md)
      enabled: false,
      batch: 10, pollSec: 5, maxPerMin: 120, minRssi: -100,
      maxSkewSec: 3600,                                // a relay frame whose send time is further than this from the relay's clock is refused (replay window)
      source: { db: '', table: 'kubotalog_backup' },   // rows waiting here (sent=0, etc IS NULL, record_id set) are the ones handed over
      store: { db: '' },                               // where mesh_relay_in / mesh_relay_out live; empty = same database as source
      sink: { type: 'inbox', db: '', dialect: 'mssql', table: '' },   // inbox = keep received rows, forward nothing (the safe default) | sql = INSERT into table
    },
  },
};

function file() { return path.join(csv.configDir(), 'mesh.json'); }

function merge(base, over) {
  if (Array.isArray(base) || base === null || typeof base !== 'object') return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = (k in base) ? merge(base[k], over[k]) : over[k];
  return out;
}

function loadMeshConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { /* absent = defaults */ }
  return merge(DEFAULTS, raw);
}

function saveMeshConfig(patch) {
  const next = merge(loadMeshConfig(), patch || {});
  if (next.key && !keyStrongEnough(next.key)) throw new Error('mesh key must be a generated secret: at least 32 hex characters (openssl rand -hex 16) or 43 base64url characters (openssl rand -base64 32)');
  csv.writeJsonAtomic(file(), next);
  return next;
}

// never hand the secret to a browser or a log
function publicMeshConfig(cfg) { const { key, ...rest } = cfg || loadMeshConfig(); return { ...rest, keySet: !!key }; }

module.exports = { DEFAULTS, loadMeshConfig, saveMeshConfig, publicMeshConfig, merge, keyStrongEnough };
