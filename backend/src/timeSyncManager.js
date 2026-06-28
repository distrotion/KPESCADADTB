// timeSyncManager.js — Peer time sync (master เผยแพร่เวลา · follower ดึงมาแก้ clock drift)
//   master = ตัวเวลาแม่น (มีเน็ต/NTP) → expose GET /api/time · follower = Pi (ไม่มี RTC) → poll + แก้
//   Phase A: offset ระดับแอป (ไม่แตะ OS) · Phase B: ตั้ง OS จริง (setClock=true · platform-aware)
//     - Linux/Pi : `date -s @<epoch>` (ต้อง CAP_SYS_TIME ใน systemd unit · ไม่ต้อง sudo)  ← เลือกข้อ (ข)
//     - Windows  : PowerShell Set-Date (ต้องรัน service แบบ admin)
//   ดู docs/TIME-SYNC-PLAN.md
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const csv = require('./csvUtil');

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
const MIN_VALID = Date.UTC(2020, 0, 1);          // เวลาที่ < ปี 2020 = เพี้ยน (กันค่าขยะ)
const MAX_AHEAD_MS = 10 * 365 * 86400000;        // > now + 10 ปี = เพี้ยน
const BIG_JUMP_MS = 60 * 60 * 1000;              // > 1 ชม. = jump ใหญ่ (อนุญาตเฉพาะ first-sync)

class TimeSyncManager {
  constructor({ tagEngine, onLog } = {}) {
    this.tagEngine = tagEngine || null;
    this.onLog = onLog || null;
    this.offsetMs = 0;            // Phase A: เวลาที่แก้ระดับแอป (correctedNow = Date.now()+offsetMs)
    this._timer = null;
    this._lastSetTs = 0;          // throttle
    this._firstDone = false;      // เคย sync แล้ว (กัน big-jump ครั้งถัดไป)
    this.status = { driftMs: null, masterEpoch: null, localEpoch: null, rttMs: null,
      lastSync: 0, lastResult: 'idle', lastError: '', applied: false };
    this._load();
  }

  // ── persistence ──────────────────────────────────────────────────────────────
  _load() {
    this.path = csv.resolveConfig('timesync.json', path.join(__dirname, 'config', 'timesync.json'));
    let raw = {}; try { raw = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch (_) {}
    this.config = this._norm(raw.config || {});
  }
  _save() { csv.writeJsonAtomic(this.path, { config: this.config }); }
  _norm(c) {
    return {
      enabled: c.enabled === true,
      role: ['master', 'follower'].includes(c.role) ? c.role : 'off',
      source: c.source === 'kpenetwork' ? 'kpenetwork' : 'http',
      masterUrl: String(c.masterUrl || '').trim(),         // follower+http เช่น http://192.168.1.50:3012
      masterPeer: String(c.masterPeer || '').trim(),        // follower+kpenetwork เช่น 'devId/__time'
      checkSec: Math.min(3600, Math.max(5, num(c.checkSec, 60))),
      thresholdMs: Math.max(50, num(c.thresholdMs, 2000)),
      minIntervalSec: Math.max(0, num(c.minIntervalSec, 30)),
      setClock: c.setClock === true,                        // false=offset แอป (Phase A) · true=ตั้ง OS (Phase B)
      firstSyncAllowBigJump: c.firstSyncAllowBigJump !== false,
    };
  }

  getConfig() { return { ...this.config }; }
  setConfig(u) { this.config = this._norm({ ...this.config, ...u }); this._save(); this._arm(); return this.getConfig(); }
  getStatus() {
    return { ...this.status, role: this.config.role, enabled: this.config.enabled, source: this.config.source,
      setClock: this.config.setClock, offsetMs: this.offsetMs, platform: process.platform, now: Date.now() };
  }
  correctedNow() { return Date.now() + this.offsetMs; }   // เวลาที่แก้แล้ว (Phase A · ให้ที่อื่นเรียกใช้ได้ภายหลัง)

  // ── lifecycle ────────────────────────────────────────────────────────────────
  start() { this._arm(); }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
  reload() { this._load(); this._arm(); }
  _arm() {
    this.stop();
    if (this.config.enabled && this.config.role === 'follower') {
      this._tick();
      this._timer = setInterval(() => this._tick(), this.config.checkSec * 1000);
    }
  }

  // ── follower poll ──────────────────────────────────────────────────────────────
  async _fetchMasterEpoch() {
    if (this.config.source === 'kpenetwork') {
      const ref = this.config.masterPeer; const bar = ref.indexOf('/');
      if (bar < 0 || !this.tagEngine) throw new Error('masterPeer ไม่ถูกต้อง (รูปแบบ deviceId/__time)');
      const v = this.tagEngine.getTagValue(ref.slice(0, bar), ref.slice(bar + 1));
      const e = Number(v && v.value);
      if (!Number.isFinite(e)) throw new Error('อ่าน __time จาก peer ไม่ได้');
      return e;
    }
    const base = this.config.masterUrl.replace(/\/+$/, '');
    if (!base) throw new Error('ยังไม่ตั้ง masterUrl');
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(base + '/api/time', { signal: ac.signal });
      if (!r.ok) throw new Error('master ตอบ HTTP ' + r.status);
      const j = await r.json();
      const e = Number(j && j.epoch);
      if (!Number.isFinite(e)) throw new Error('master ตอบไม่มี epoch');
      return e;
    } finally { clearTimeout(to); }
  }

  async _tick() {
    try {
      const t0 = Date.now();
      const masterRaw = await this._fetchMasterEpoch();
      const t1 = Date.now();
      const rtt = t1 - t0;
      // latency correction (rtt/2) เฉพาะ http (kpenetwork = push อยู่แล้ว ไม่ต้อง)
      const masterNow = masterRaw + (this.config.source === 'http' ? rtt / 2 : 0);
      const drift = masterNow - t1;   // master เร็วกว่า local เท่าไร (บวก=local ช้า)
      Object.assign(this.status, { driftMs: Math.round(drift), masterEpoch: Math.round(masterNow),
        localEpoch: t1, rttMs: rtt, lastSync: Date.now(), lastError: '' });

      // sanity — กันค่าเพี้ยน
      if (!(masterNow > MIN_VALID && masterNow < Date.now() + MAX_AHEAD_MS)) {
        this.status.lastResult = 'rejected-insane';
        this.status.lastError = 'master time นอกช่วงสมเหตุผล: ' + new Date(masterNow).toISOString();
        return;
      }
      if (Math.abs(drift) <= this.config.thresholdMs) { this.status.lastResult = 'in-sync'; this.status.applied = false; return; }
      // throttle (ไม่ตั้งถี่เกิน)
      if (this._lastSetTs && (Date.now() - this._lastSetTs) < this.config.minIntervalSec * 1000) { this.status.lastResult = 'throttled'; return; }

      const bigJump = Math.abs(drift) > BIG_JUMP_MS;
      if (this.config.setClock) {   // Phase B — ตั้ง OS จริง
        if (bigJump && (this._firstDone || !this.config.firstSyncAllowBigJump)) {
          this.status.lastResult = 'rejected-bigjump';
          this.status.lastError = `drift ใหญ่เกิน 1 ชม. (${Math.round(drift / 1000)}s) — ไม่ตั้งอัตโนมัติ (กันค่าเพี้ยน)`;
          this._log('reject big-jump ' + Math.round(drift / 1000) + 's');
          return;
        }
        await this._setSystemClock(masterNow);
        this._lastSetTs = Date.now(); this._firstDone = true; this.offsetMs = 0;
        this.status.lastResult = 'os-set'; this.status.applied = true;
        this._log(`ตั้งนาฬิกา OS → ${new Date(masterNow).toISOString()} (drift ${Math.round(drift)}ms)`);
      } else {                      // Phase A — offset ระดับแอป (ไม่แตะ OS)
        this.offsetMs = Math.round(drift);
        this._lastSetTs = Date.now(); this._firstDone = true;
        this.status.lastResult = 'app-offset'; this.status.applied = true;
        this._log(`offset แอป ${this.offsetMs}ms (drift ${Math.round(drift)}ms)`);
      }
    } catch (e) { this.status.lastResult = 'error'; this.status.lastError = e.message; }
  }

  // ── ตั้งนาฬิกา OS (platform-aware) ──────────────────────────────────────────────
  _setSystemClock(epochMs) {
    return new Promise((resolve, reject) => {
      const plt = process.platform;
      if (plt === 'linux') {
        const sec = (epochMs / 1000).toFixed(3);   // date -s @<epoch> = settimeofday (ต้อง CAP_SYS_TIME)
        execFile('date', ['-s', '@' + sec], (err) => err ? reject(new Error('date -s ล้มเหลว: ' + err.message + ' (Pi ต้องมี CAP_SYS_TIME ใน systemd unit)')) : resolve());
      } else if (plt === 'win32') {
        const ps = `Set-Date -Date ([DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(epochMs)}).LocalDateTime)`;
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) => err ? reject(new Error('Set-Date ล้มเหลว: ' + err.message + ' (ต้องรัน service เป็น admin)')) : resolve());
      } else {
        reject(new Error('ตั้งนาฬิกาบน ' + plt + ' ยังไม่รองรับ — ใช้โหมด offset แทน (setClock=false)'));
      }
    });
  }
  _log(detail) { try { if (this.onLog) this.onLog(detail); } catch (_) {} console.log('[timesync]', detail); }
}

module.exports = TimeSyncManager;
