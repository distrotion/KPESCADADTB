const fs = require('fs');
const path = require('path');

/**
 * RS485 direction (DE/RE) on a Raspberry Pi GPIO line — for MAX485-style modules on the header UART.
 *
 * HIGH = transmit (DE on, RE off) · LOW = receive. The line starts LOW and is left LOW on close.
 *
 * Uses the sysfs GPIO interface on purpose: changing the level is one write() on an open fd
 * (microseconds), fast enough to drop DE before a Modbus slave answers (≥ 3.5 character times,
 * about 1.75–4 ms). gpioDriver's libgpiod CLI spawns a process per change (milliseconds), which
 * would lose the first bytes of the reply.
 */
const HEADER_CHIP = /^pinctrl-(rp1|bcm2711|bcm2835)$/;   // 40-pin header chip: Pi 5 / Pi 4 / Pi 3
const OPEN_RETRIES = 40;                                 // udev gives the new files to group gpio a few ms after export
const OPEN_RETRY_MS = 25;

class Rs485Direction {
  constructor(gpio, { root = '/sys/class/gpio', fsImpl = fs, sleep } = {}) {
    if (!Number.isInteger(gpio) || gpio < 0 || gpio > 53) throw new Error(`RS485 DE/RE GPIO "${gpio}" is not a valid BCM number`);
    this.gpio = gpio;
    this.root = root;
    this.fs = fsImpl;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fd = null;
    this.line = null;
    this._exportedHere = false;
  }

  _headerBase() {
    for (const name of this.fs.readdirSync(this.root)) {
      if (!name.startsWith('gpiochip')) continue;
      const chipDir = path.join(this.root, name);
      const label = this.fs.readFileSync(path.join(chipDir, 'label'), 'utf8').trim();
      if (HEADER_CHIP.test(label)) return parseInt(this.fs.readFileSync(path.join(chipDir, 'base'), 'utf8'), 10);
    }
    throw new Error(`RS485 DE/RE: 40-pin header GPIO chip not found in ${this.root}`);
  }

  async open() {
    if (this.fd !== null) return;
    const line = this._headerBase() + this.gpio;
    const lineDir = path.join(this.root, 'gpio' + line);
    if (!this.fs.existsSync(lineDir)) {
      try { this.fs.writeFileSync(path.join(this.root, 'export'), String(line)); }
      catch (e) { throw new Error(`RS485 DE/RE: GPIO${this.gpio} export failed (${e.code || e.message}) — is it used by a GPIO device?`); }
      this._exportedHere = true;
    }
    let lastError;
    for (let attempt = 0; attempt < OPEN_RETRIES; attempt++) {
      try {
        this.fs.writeFileSync(path.join(lineDir, 'direction'), 'low');   // output that starts LOW, no glitch to HIGH
        this.fd = this.fs.openSync(path.join(lineDir, 'value'), 'w');
        this.line = line;
        return;
      } catch (e) {
        lastError = e;
        await this.sleep(OPEN_RETRY_MS);
      }
    }
    throw new Error(`RS485 DE/RE: GPIO${this.gpio} is not writable (${lastError && (lastError.code || lastError.message)})`);
  }

  set(transmit) {
    if (this.fd === null) throw new Error('RS485 DE/RE line is not open');
    this.fs.writeSync(this.fd, transmit ? '1' : '0', 0);
  }

  // Back to receive, then hand the line back so a GPIO device can use it later.
  close() {
    if (this.fd !== null) {
      try { this.set(false); } catch (_) {}
      try { this.fs.closeSync(this.fd); } catch (_) {}
      this.fd = null;
    }
    if (this._exportedHere && this.line !== null) {
      try { this.fs.writeFileSync(path.join(this.root, 'unexport'), String(this.line)); } catch (_) {}
      this._exportedHere = false;
    }
  }
}

module.exports = Rs485Direction;
