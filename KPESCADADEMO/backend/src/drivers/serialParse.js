/**
 * Serial parse — module แชร์: แปลง 1 frame (string) → tag values ตาม parseMode
 * ────────────────────────────────────────────────────────────────────────────
 * ย้ายมาจาก serialDriver._parse (behavior เดิม) → ใช้ร่วม serial_port + serial_bridge
 *   parseMode: function | regex | csv | json | keyvalue | raw
 * compileTransform(code, id) → vm.Script | null  (สำหรับ function mode)
 * parseFrame({ line, cfg, tags, script, onTag, deviceId, logId })
 *   - line    : frame ที่ trim แล้ว (string)
 *   - cfg     : connection config (parseMode, csvSeparator, kvPairSep, kvSep, transform)
 *   - tags    : รายการ tag ที่จะ map (ต่อทิศแล้ว) — { id, jsonKey, regex, regexGroup, csvIndex, scale }
 *   - script  : compiled vm.Script (function mode) | null
 *   - onTag   : (deviceId, tagId, value) → set ค่า
 *   - logId   : ป้าย log/console (default = deviceId)
 */
const vm = require('vm');

const _isNumStr = (s) => /^[\s+\-]?[\d.,eE+\-]+$/.test(String(s).trim());
const _lastErr = new Map();   // throttle error log ต่อ logId

function compileTransform(code, id) {
  if (!code) return null;
  try {
    return new vm.Script(`(function(msg, parseNum){ ${code}\n})`, { filename: `transform_${id}.js` });
  } catch (err) {
    console.error(`[Serial] Transform compile error (${id}):`, err.message);
    return null;
  }
}

function parseFrame({ line, cfg, tags, script, onTag, deviceId, logId }) {
  if (!line) return;
  cfg = cfg || {};
  tags = tags || [];
  logId = logId || deviceId;
  const mode = String(cfg.parseMode || 'function').toLowerCase();

  try {
    // ── FUNCTION mode (Node-RED style) ──────────────────────────────────
    if (mode === 'function') {
      if (!script) return;
      const sandbox = {
        msg: line,
        parseNum: (s) => { const n = parseFloat(s); return isNaN(n) ? null : n; },
        parseInt, parseFloat, Math, JSON, Number, String, isNaN,
        console: { log: (...a) => console.log(`[Serial:${logId}]`, ...a) },
      };
      const fn = script.runInNewContext(sandbox, { timeout: 200 });
      const result = fn(line, sandbox.parseNum);
      if (result && typeof result === 'object') {
        for (const tag of tags) {
          const key = tag.jsonKey || tag.id;
          if (result[key] !== undefined) {
            let v = result[key];
            if (tag.scale && typeof v === 'number') v = v * tag.scale;
            onTag(deviceId, tag.id, v);
          }
        }
      }
      return;
    }

    // ── REGEX mode ──────────────────────────────────────────────────────
    if (mode === 'regex') {
      for (const tag of tags) {
        if (!tag.regex) continue;
        let re; try { re = new RegExp(tag.regex); } catch (_) { continue; }
        const m = line.match(re); if (!m) continue;
        const g = (tag.regexGroup != null) ? tag.regexGroup : (m.length > 1 ? 1 : 0);
        let raw = m[g]; if (raw === undefined) continue;
        let v = raw;
        if (_isNumStr(raw)) { v = parseFloat(raw); if (tag.scale) v *= tag.scale; }
        onTag(deviceId, tag.id, v);
      }
      return;
    }

    // ── CSV mode ────────────────────────────────────────────────────────
    if (mode === 'csv') {
      const sep = cfg.csvSeparator || ',';
      const parts = line.split(sep);
      for (const tag of tags) {
        const idx = tag.csvIndex ?? -1;
        if (idx >= 0 && idx < parts.length) {
          let v = parseFloat(parts[idx]);
          if (!isNaN(v)) { if (tag.scale) v *= tag.scale; onTag(deviceId, tag.id, v); }
        }
      }
      return;
    }

    // ── JSON / keyvalue / raw ───────────────────────────────────────────
    let parsed = {};
    if (mode === 'json') {
      parsed = JSON.parse(line);
    } else if (mode === 'keyvalue') {
      const sep = cfg.kvPairSep || ';';
      const kv  = cfg.kvSep     || '=';
      for (const pair of line.split(sep)) {
        const i = pair.indexOf(kv);
        if (i > 0) parsed[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    } else {
      // raw → ทั้งบรรทัดไป tag แรก
      if (tags.length > 0) onTag(deviceId, tags[0].id, line);
      return;
    }
    for (const tag of tags) {
      const key = tag.jsonKey || tag.id;
      if (parsed[key] !== undefined) {
        let v = parsed[key];
        if (typeof v === 'string' && _isNumStr(v)) v = parseFloat(v);
        if (tag.scale && typeof v === 'number') v *= tag.scale;
        onTag(deviceId, tag.id, v);
      }
    }
  } catch (err) {
    if (mode === 'function') {
      const last = _lastErr.get(logId) || 0;
      if (Date.now() - last > 5000) { console.error(`[Serial] Transform error (${logId}):`, err.message); _lastErr.set(logId, Date.now()); }
    }
    // json/other = noise → เงียบ (เหมือนเดิม)
  }
}

module.exports = { compileTransform, parseFrame };
