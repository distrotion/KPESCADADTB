// KPE SCADA — ตัว resolve พอร์ตกลาง (ใช้ร่วม backend/serve.js/manager/deploy.js)
//   ลำดับความสำคัญ: env > ports.json (root) > default
//   ไฟล์ ports.json อยู่ที่ root (ข้างไฟล์นี้) — resolve จาก __dirname จึง move-safe
//   ⚠️ เปลี่ยนพอร์ตแล้วต้อง restart process ถึงมีผล (พอร์ต bind ตอน start)
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'ports.json');

function _fromFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

function ports() {
  const f = _fromFile();
  const pick = (env, key, def) => {
    const v = process.env[env] || f[key] || def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const backend = pick('KPE_BACKEND_PORT', 'backend', 4012);
  const ft = f.tls || {};
  // TLS/HTTPS — ใช้กับ "ขอบ" (serve.js + deploy.js) เท่านั้น · backend/manager คง http ภายใน
  //   enabled: env KPE_TLS_ENABLED (1/0) > ports.json tls.enabled · cert/key: env > file
  const tlsEnabled = process.env.KPE_TLS_ENABLED === '1' ? true
    : process.env.KPE_TLS_ENABLED === '0' ? false
    : (ft.enabled === true);
  return {
    frontend: pick('KPE_PORT', 'frontend', 3012),         // พอร์ตสาธารณะ (UI + proxy)
    backend,                                              // backend ภายใน
    manager:  pick('KPE_MANAGER_PORT', 'manager', 5012),
    deploy:   pick('KPE_DEPLOY_PORT', 'deploy', 9012),    // เว็บ run-mode ที่ deploy
    backendHost: process.env.KPE_BACKEND_HOST || f.backendHost || '127.0.0.1',
    // backend ที่ deploy web จะจับคู่ (proxy ไป) — default = backend ปัจจุบันบนเครื่องเดียวกัน
    deployBackendHost: process.env.KPE_DEPLOY_BACKEND_HOST || f.deployBackendHost || '127.0.0.1',
    deployBackendPort: pick('KPE_DEPLOY_BACKEND_PORT', 'deployBackendPort', backend),
    tls: {
      enabled: tlsEnabled,
      cert: process.env.KPE_TLS_CERT || ft.cert || '',     // path ไฟล์ cert (PEM)
      key:  process.env.KPE_TLS_KEY  || ft.key  || '',     // path ไฟล์ key (PEM)
    },
  };
}

// เขียน ports.json (เฉพาะ key ที่ส่งมา + ตรวจช่วง 1–65535) — คืน config ใหม่
function save(input) {
  const cur = _fromFile();
  const next = { ...cur };
  for (const k of ['frontend', 'backend', 'manager', 'deploy', 'deployBackendPort']) {
    if (input[k] != null && input[k] !== '') {
      const n = parseInt(input[k], 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`พอร์ต ${k} ไม่ถูกต้อง (1–65535)`);
      next[k] = n;
    }
  }
  for (const h of ['backendHost', 'deployBackendHost']) {
    if (input[h]) next[h] = String(input[h]).trim();
  }
  // TLS config (HTTPS) — { enabled, cert, key }
  if (input.tls && typeof input.tls === 'object') {
    const t = { ...(cur.tls || {}) };
    if (typeof input.tls.enabled === 'boolean') t.enabled = input.tls.enabled;
    if (input.tls.cert != null) t.cert = String(input.tls.cert).trim();
    if (input.tls.key != null) t.key = String(input.tls.key).trim();
    next.tls = t;
  }
  // กันพอร์ต service หลักซ้ำกัน (frontend/backend/manager/deploy)
  const eff = { ...ports(), ...next };
  if (new Set([eff.frontend, eff.backend, eff.manager, eff.deploy]).size < 4) {
    throw new Error('พอร์ต frontend/backend/manager/deploy ต้องไม่ซ้ำกัน');
  }
  // atomic write (B3) — tmp+rename กัน ports.json พังตอนไฟดับ (host-specific, สำคัญต่อ boot)
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  return next;
}

module.exports = { ports, save, FILE };
