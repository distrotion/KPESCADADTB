const cp = require('child_process');

/**
 * GPIO Driver — Raspberry Pi digital I/O ผ่าน libgpiod CLI (gpioget/gpioset)
 * ดูดีไซน์เต็ม + ข้อควรระวัง: docs/GPIO-DEVICE-TYPE.md
 *
 *  • real mode : shell ออกไป libgpiod (pure-JS · ไม่มี npm native dep) — ต้องมี `gpiod` (apt install gpiod)
 *  • sim  mode : pin map ในหน่วยความจำ — รันได้ทุก OS (dev บน Mac/Win)
 *  • เลือกโหมด: device.connection.mode = 'real' | 'sim' | 'auto' (default 'auto')
 *      auto = real ถ้าเป็น linux + มี gpiodetect สำเร็จ · ไม่งั้น → sim
 *
 *  tag: { pin (BCM), direction:'in'|'out', activeLow:bool, pull:'up'|'down'|'none', dataType:'BOOL', initial?, simValue? }
 *  device.connection: { chip:'gpiochip0', mode:'auto' }
 *
 *  ⚠️ v1 (ดู §13 ของ doc):
 *   - output ค้างค่าด้วย 1 process `gpioset --mode=wait` ถือทุก output line · เปลี่ยนค่า = respawn (กระตุกทุกขา ~ms)
 *   - input อ่านแบบ poll ต่อขา (ยังไม่ batch · ยังไม่จับ pulse สั้น/ debounce — edge รอ P4)
 *   - activeLow จัดการในไดรเวอร์เอง (ไม่พึ่ง flag -l ของ libgpiod) → per-pin ถูกต้อง + รวม holder ได้
 *   - libgpiod v1 syntax (Bookworm 1.6.x) · v2 + chip-detect (Pi 5 = gpiochip4) = P3
 *
 *  interface เดียวกับ driver อื่น: connect()/disconnect()/readTag(tag)→0|1|null/writeTag(tag,value)/connected
 */
class GpioDriver {
  constructor(device) {
    this.device = device;
    this.type = 'gpio';
    this.connected = false;

    const conn = device.connection || {};
    this.chip = conn.chip || 'auto';      // 'auto' = ตรวจหา 40-pin header เอง (Pi5=gpiochip4, Pi4=gpiochip0)
    this.mode = conn.mode || 'auto';      // 'real' | 'sim' | 'auto'

    this._resolvedMode = null;            // 'real' | 'sim' (หลัง connect)
    this._gpiodMajor = 1;                 // libgpiod major version (1 หรือ 2) — syntax ต่างกัน (P3)
    this._sim = new Map();                // pin -> logical 0/1 (sim input/store)
    this._outState = new Map();           // pin -> logical 0/1 (desired output · ทั้ง 2 โหมด)
    this._holder = null;                  // persistent gpioset child (real output holder)
    this._holderTimes = [];               // crash-loop guard (respawn timestamps)
    this._holderTimer = null;
    this._version = null;
    this._lastError = null;

    this._cp = cp;                        // hook ได้สำหรับ test (mock execFileSync/spawn)
    this._isLinux = process.platform === 'linux';   // override ได้ใน test เพื่อ exercise real branch
  }

  // ── helpers รัน CLI (แยกชั้น → mock ได้ตอนเทสต์) ─────────────────────────────
  _run(bin, args) {
    return { stdout: this._cp.execFileSync(bin, args, { timeout: 3000, encoding: 'utf8' }) };
  }
  _spawn(bin, args) {
    return this._cp.spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  }
  _detect() {
    try { this._run('gpiodetect', []); return true; } catch (_) { return false; }
  }
  _detectVersion() {
    try {
      const o = (this._run('gpiodetect', ['--version']).stdout || '');
      const m = o.match(/v?(\d+)\.\d+/);          // "(libgpiod) v1.6.3" หรือ "(libgpiod) 2.1"
      this._gpiodMajor = m ? parseInt(m[1], 10) : 1;
      return o.trim().split('\n')[0] || null;
    } catch (_) { this._gpiodMajor = 1; return null; }
  }
  // หา gpiochip ของหัว 40-pin เอง (เมื่อ chip='auto') — label มี 'pinctrl' + line เยอะสุด
  //   Pi5 = gpiochip4 [pinctrl-rp1] (54) · Pi4 = gpiochip0 [pinctrl-bcm2711] (58) · Pi3 = pinctrl-bcm2835
  _resolveChip() {
    if (this.chip && this.chip !== 'auto') return this.chip;
    try {
      const out = this._run('gpiodetect', []).stdout || '';
      let best = null, bestLines = -1;
      for (const line of out.split('\n')) {
        const m = line.match(/^(gpiochip\d+)\s+\[([^\]]+)\]\s+\((\d+)\s+lines?\)/);
        if (!m) continue;
        const lines = parseInt(m[3], 10);
        if (/pinctrl/i.test(m[2]) && lines > bestLines) { best = m[1]; bestLines = lines; }
      }
      return best || 'gpiochip0';
    } catch (_) { return 'gpiochip0'; }
  }

  // ── adapter syntax libgpiod v1 vs v2 (P3) ────────────────────────────────────
  //   v1: gpioget [-B pull-up] <chip> <off>      · gpioset --mode=wait <chip> off=val
  //   v2: gpioget --numeric -c <chip> [--bias=]  off · gpioset -c <chip> off=val (hold จน kill)
  _isV2() { return (this._gpiodMajor || 1) >= 2; }
  _biasArgs(tag) {
    const v2 = this._isV2();
    const name = { up: 'pull-up', down: 'pull-down', none: v2 ? 'disabled' : 'disable' }[tag.pull];
    if (!name) return [];
    return v2 ? [`--bias=${name}`] : ['-B', name];
  }
  _getArgs(tag) {   // args ของ gpioget (ไม่รวม bin) · activeLow จัดการในไดรเวอร์เอง (ไม่ใช้ -l)
    const v2 = this._isV2();
    const a = [];
    if (v2) a.push('--numeric', '-c', this.chip);
    a.push(...this._biasArgs(tag));
    if (v2) a.push(String(tag.pin));
    else a.push(this.chip, String(tag.pin));
    return a;
  }
  _setArgs(pairs) { // args ของ gpioset (holder ค้างค่า) · pairs = ['17=1','27=0']
    return this._isV2() ? ['-c', this.chip, ...pairs] : ['--mode=wait', this.chip, ...pairs];
  }

  async connect() {
    // sim ชัดเจน
    if (this.mode === 'sim') return this._startSim();
    // real/auto → ตรวจความพร้อม
    const ready = this._isLinux && this._detect();
    if (!ready) {
      if (this.mode === 'real') {
        this.connected = false;
        this._lastError = !this._isLinux
          ? 'GPIO real ใช้ได้เฉพาะ Linux/Raspberry Pi'
          : 'ไม่พบ libgpiod (apt install gpiod) หรือไม่มี gpiochip';
        console.error(`[GPIO] ${this.device.name}: ${this._lastError}`);
        return;
      }
      // auto → fallback sim
      return this._startSim();
    }
    this._resolvedMode = 'real';
    this._version = this._detectVersion();   // ตั้ง _gpiodMajor
    this.chip = this._resolveChip();         // 'auto' → gpiochip จริง (Pi5=gpiochip4)
    this._lastError = null;
    this._rebuildOutputs();               // สตาร์ท holder ตาม output ปัจจุบัน (initial)
    this.connected = true;
    console.log(`[GPIO] ${this.device.name}: real (${this.chip}, libgpiod v${this._gpiodMajor} · ${this._version || ''})`);
  }

  _startSim() {
    this._resolvedMode = 'sim';
    this._lastError = null;
    // seed: output = initial · input = simValue (ถ้ามี) — เก็บเป็น logical
    for (const t of this.device.tags || []) {
      if (t.pin == null) continue;
      if (t.direction === 'out') this._outState.set(t.pin, t.initial ? 1 : 0);
      else this._sim.set(t.pin, t.simValue ? 1 : 0);
    }
    this.connected = true;
    console.log(`[GPIO] ${this.device.name}: simulator`);
  }

  // ── อ่าน ─────────────────────────────────────────────────────────────────────
  async readTag(tag) {
    if (tag.pin == null) return null;
    // output: คืน "ค่าที่ตั้งไว้" (อ่านขาที่เรากำลังขับด้วย gpioget จะ EBUSY) — ทั้ง 2 โหมด
    if (tag.direction === 'out') {
      return this._outState.has(tag.pin) ? this._outState.get(tag.pin) : (tag.initial ? 1 : 0);
    }
    // input
    if (this._resolvedMode === 'sim') {
      return this._sim.has(tag.pin) ? this._sim.get(tag.pin) : (tag.simValue ? 1 : 0);
    }
    try {
      const out = (this._run('gpioget', this._getArgs(tag)).stdout || '').trim();
      const raw = out.split(/\s+/).pop() === '1' ? 1 : 0;     // คืน "0"/"1" (v2 ใช้ --numeric)
      return tag.activeLow ? (raw ? 0 : 1) : raw;             // activeLow จัดการเอง
    } catch (e) {
      this.connected = false;
      return null;
    }
  }

  // ── เขียน (output เท่านั้น) ───────────────────────────────────────────────────
  async writeTag(tag, value) {
    if (!this.connected) throw new Error('Not connected');
    if (tag.direction !== 'out') throw new Error(`เขียนขา input ไม่ได้ (BCM ${tag.pin})`);
    const v = value ? 1 : 0;
    this._outState.set(tag.pin, v);                          // เก็บ logical
    if (this._resolvedMode === 'sim') { this._sim.set(tag.pin, v); return; }
    this._rebuildOutputs();                                  // respawn holder ด้วยค่าใหม่
  }

  // desired output (raw electrical) ของทุกขา out — ใส่ activeLow แล้ว
  _desiredOutputs() {
    const map = new Map();
    for (const t of this.device.tags || []) {
      if (t.direction === 'out' && t.pin != null) {
        const logical = this._outState.has(t.pin) ? this._outState.get(t.pin) : (t.initial ? 1 : 0);
        map.set(t.pin, t.activeLow ? (logical ? 0 : 1) : logical);   // raw
      }
    }
    return map;
  }

  // คง 1 process gpioset ถือ output ทุกขา (libgpiod v1: gpioset --mode=wait gpiochip0 17=1 27=0)
  _rebuildOutputs() {
    this._killHolder();
    const outs = this._desiredOutputs();
    if (outs.size === 0) return;
    const pairs = [...outs.entries()].map(([p, v]) => `${p}=${v}`);
    const child = this._spawn('gpioset', this._setArgs(pairs));
    this._holder = child;
    child.on('exit', () => {
      if (this._holder === child) this._holder = null;
      if (this.connected && this._resolvedMode === 'real') this._scheduleHolderRespawn();
    });
  }

  _killHolder() {
    if (this._holderTimer) { clearTimeout(this._holderTimer); this._holderTimer = null; }
    if (this._holder) { try { this._holder.kill('SIGTERM'); } catch (_) {} this._holder = null; }
  }

  // crash-loop guard: gpioset ตายเอง → respawn (ตายรัว >5/60s → หยุด)
  _scheduleHolderRespawn() {
    const now = Date.now();
    this._holderTimes = this._holderTimes.filter(t => now - t < 60000);
    this._holderTimes.push(now);
    if (this._holderTimes.length > 5) {
      console.error(`[GPIO] ${this.device.name}: gpioset crash-loop → หยุด respawn (ตรวจ permission/ขาชน)`);
      return;
    }
    this._holderTimer = setTimeout(() => {
      this._holderTimer = null;
      if (this.connected && this._resolvedMode === 'real' && !this._holder) this._rebuildOutputs();
    }, Math.min(this._holderTimes.length * 500, 3000));
  }

  disconnect() {
    this.connected = false;
    this._killHolder();
  }

  // สำหรับ UI badge real/sim (wire endpoint ใน P2/P3)
  getStatus() {
    return { mode: this._resolvedMode, chip: this.chip, version: this._version, libgpiodMajor: this._gpiodMajor, error: this._lastError };
  }
}

module.exports = GpioDriver;
