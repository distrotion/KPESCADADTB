'use strict';
// Supervises the Python BLE helper (ble/kpe_ble.py) that talks to BlueZ over D-Bus.
// Node never touches Bluetooth itself: the helper advertises this node's beacon and prints every
// beacon it hears as one JSON line. If the helper dies it is restarted with a growing delay, and
// nothing that happens here can stop the backend or a weighing station.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'ble', 'kpe_ble.py');
const FORWARDED = new Set(['ready', 'adv', 'stats', 'relay-in']);
const EXIT_UNAVAILABLE = 3;          // python modules or the adapter are missing: retry slowly, it needs a person or an install

class BleHelper extends EventEmitter {
  constructor({ script = SCRIPT, python = 'python3', adapter = 'hci0', spawnFn = spawn, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    super();
    Object.assign(this, { script, python, adapter, spawnFn, log, setTimer, clearTimer, now });
    this.child = null; this.timer = null; this.health = null; this.wanted = false; this.restarts = 0; this.backoffMs = 5000;
    this.state = 'stopped'; this.lastError = null; this.lastEventAt = 0; this.beaconHex = null; this.scan = null; this.buf = '';
    this.counts = { beacons: 0, badLines: 0 };
    this.serve = false; this.pendingSends = new Map(); this.sendSeq = 0;
    this.lastAdvAt = 0; this.lastBeaconSentAt = 0; this.lastAdvErrorAt = 0;          // the helper prints 'adv' every time a beacon swap succeeded; silence while beacons are being sent = it cannot advertise
  }

  start() {
    if (this.wanted) return;
    this.wanted = true; this._spawn();
    if (!this.health) { this.health = setInterval(() => this._checkHealth(), 30000); if (this.health.unref) this.health.unref(); }
  }

  // the helper prints a "stats" line every 30 s even in an empty room; silence for 2 minutes (or no confirmed beacon swap for 90 s) means it is wedged
  _checkHealth() {
    if (!this.child || this.state !== 'ready') return false;
    const t = this.now();
    let why = null;
    if (t - this.lastEventAt >= 120000) why = 'no output for 120 s';
    // its 30 s stats line keeps arriving even when its job queue is wedged, so also require the beacon to actually get onto the air
    // (a helper that is still ATTEMPTING and being refused - e.g. another BlueZ client is scanning - is blocked from outside, not wedged: restarting it would not help and would drop relay serving)
    else if (this.beaconHex && t - this.lastBeaconSentAt < 30000 && t - this.lastAdvAt >= 90000 && t - this.lastAdvErrorAt >= 90000) why = 'no beacon swap confirmed for 90 s while beacons are being sent';
    if (!why) return false;
    this.lastError = why + ': restarting the helper';
    this.log('[mesh] ble helper ' + why + ', restarting it');
    try { this.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    return true;
  }

  stop() {
    this.wanted = false;
    for (const [id, p] of this.pendingSends) { this.clearTimer(p.timer); p.resolve({ ok: false, why: 'helper-stopped' }); this.pendingSends.delete(id); }
    if (this.health) { clearInterval(this.health); this.health = null; }
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    const c = this.child;
    if (c) {
      try { this._send({ cmd: 'quit' }); } catch (_) { /* already gone */ }
      const killer = this.setTimer(() => { try { c.kill('SIGKILL'); } catch (_) { /* gone */ } }, 2000);
      if (killer && killer.unref) killer.unref();
    }
    this.state = 'stopped';
  }

  setBeacon(hex) { this.beaconHex = hex; this.lastBeaconSentAt = this.now(); this._send({ cmd: 'beacon', hex }); }
  setScan(scan) { this.scan = scan; this._send({ cmd: 'scan', on: scan.on, off: scan.off }); }

  // relay hand-over (T8): serve = accept frames from neighbours (GATT server); relaySend = connect to a neighbour and write one frame
  relayServe(on, sid, boot) { this.serve = !!on; if (on) this.serveId = { sid, boot }; this._send({ cmd: 'relay-serve', on: !!on, sid: (this.serveId || {}).sid, boot: (this.serveId || {}).boot }); }
  relayPeers(sids) { this.peerSids = Array.isArray(sids) ? sids.filter((x) => Number.isInteger(x)) : null; if (this.peerSids) this._send({ cmd: 'relay-peers', sids: this.peerSids }); }
  relayAck(id, ok, why, ack) { return this._send({ cmd: 'relay-ack', id, ok: !!ok, why: why || '', ack: ack || '' }); }
  relaySend(sid, hex, timeoutMs = 20000) {
    return new Promise((resolve) => {
      if (this.state !== 'ready') { resolve({ ok: false, why: 'helper-not-ready' }); return; }
      const id = ++this.sendSeq;
      const timer = this.setTimer(() => { if (this.pendingSends.delete(id)) resolve({ ok: false, why: 'timeout' }); }, timeoutMs);
      if (timer && timer.unref) timer.unref();
      this.pendingSends.set(id, { resolve, timer });
      if (!this._send({ cmd: 'relay-send', id, sid, hex })) { this.pendingSends.delete(id); this.clearTimer(timer); resolve({ ok: false, why: 'helper-not-writable' }); }
    });
  }

  status() {
    return { state: this.state, pid: this.child ? this.child.pid : null, restarts: this.restarts, lastError: this.lastError,
      lastEventAt: this.lastEventAt || null, adapter: this.adapter, counts: { ...this.counts } };
  }

  _send(obj) {
    const c = this.child;
    if (!c || !c.stdin || !c.stdin.writable) return false;
    try { c.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { this.lastError = 'stdin: ' + e.message; return false; }
  }

  _spawn() {
    if (!this.wanted || this.child) return;
    this.state = 'starting'; this.lastAdvAt = this.now();
    let child;
    try { child = this.spawnFn(this.python, [this.script, '--adapter', this.adapter], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { this.lastError = 'spawn: ' + e.message; this.log('[mesh] ble helper spawn failed: ' + e.message); this._retry(this.backoffMs); return; }
    this.child = child; this.buf = '';
    // a write to a child that has just died raises EPIPE as an 'error' event on its stdin; with no listener that is an uncaught exception
    for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) {
      if (stream && stream.on) stream.on('error', (e) => { this.lastError = `${name}: ${e.message}`; });
    }
    child.stdout.on('data', (d) => this._data(d));
    child.stderr.on('data', (d) => { this.lastError = String(d).trim().split('\n').pop().slice(0, 200); });
    child.on('error', (e) => { this.lastError = 'process: ' + e.message; });
    child.on('exit', (code, sig) => {
      if (this.child !== child) return;
      this.child = null;
      for (const [id, p] of this.pendingSends) { this.clearTimer(p.timer); p.resolve({ ok: false, why: 'helper-exited' }); this.pendingSends.delete(id); }
      const unavailable = code === EXIT_UNAVAILABLE;
      this.state = this.wanted ? (unavailable ? 'unavailable' : 'backoff') : 'stopped';
      if (!this.wanted) return;
      this.restarts++;
      this.log(`[mesh] ble helper exited (code ${code}${sig ? ', ' + sig : ''})${this.lastError ? ': ' + this.lastError : ''}`);
      this._retry(unavailable ? 10 * 60 * 1000 : this.backoffMs);
      if (!unavailable) this.backoffMs = Math.min(60000, this.backoffMs * 2);
    });
  }

  _retry(ms) {
    if (this.timer || !this.wanted) return;
    this.timer = this.setTimer(() => { this.timer = null; this._spawn(); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  _data(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { this.counts.badLines++; continue; }
      if (!ev || typeof ev.ev !== 'string') { this.counts.badLines++; continue; }
      this.lastEventAt = this.now();
      if (ev.ev === 'ready') {
        this.state = 'ready'; this.backoffMs = 5000; this.lastError = null; this.lastAdvAt = this.now();
        if (this.beaconHex) this._send({ cmd: 'beacon', hex: this.beaconHex });
        if (this.scan) this._send({ cmd: 'scan', on: this.scan.on, off: this.scan.off });
        if (this.serve) this._send({ cmd: 'relay-serve', on: true, sid: (this.serveId || {}).sid, boot: (this.serveId || {}).boot });
        if (this.peerSids) this._send({ cmd: 'relay-peers', sids: this.peerSids });
      } else if (ev.ev === 'beacon') {
        this.counts.beacons++;
        if (typeof ev.hex === 'string') this.emit('beacon', { hex: ev.hex, rssi: typeof ev.rssi === 'number' ? ev.rssi : null, addr: typeof ev.addr === 'string' ? ev.addr : null, t: ev.t });
        continue;
      } else if (ev.ev === 'relay-result') {
        const p = this.pendingSends.get(ev.id);
        if (p) { this.pendingSends.delete(ev.id); this.clearTimer(p.timer); p.resolve({ ok: !!ev.ok, why: ev.why || null, ms: ev.ms == null ? null : ev.ms, ack: typeof ev.ack === 'string' ? ev.ack : null, wt: Number.isFinite(ev.wt) ? ev.wt : null }); }
        continue;
      } else if (ev.ev === 'adv') {
        if (ev.kind !== 'relay') { this.lastAdvAt = this.now(); if (/^adv:/.test(this.lastError || '')) this.lastError = null; }     // a beacon swap succeeded: the beacon is on the air
        this.emit('adv', ev); continue;
      } else if (ev.ev === 'error') {
        this.lastError = `${ev.where || 'helper'}: ${ev.msg || ''}`.slice(0, 200);
        if (ev.where === 'adv') this.lastAdvErrorAt = this.now();
        this.emit('helper-error', ev);      // never emit 'error' itself: an EventEmitter throws on it when nobody listens, and that would take the backend down
        continue;
      }
      if (FORWARDED.has(ev.ev)) this.emit(ev.ev, ev);       // only the events we know; a stray line must not fire arbitrary listeners
    }
    if (this.buf.length > 65536) this.buf = '';             // an unterminated runaway line must not eat memory (complete lines were already handled above)
  }
}

module.exports = { BleHelper, SCRIPT, EXIT_UNAVAILABLE };
