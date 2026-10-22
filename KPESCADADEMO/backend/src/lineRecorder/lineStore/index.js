// LineStore factory — สลับ DB ได้ผ่าน config.type (file | pg | mssql | mysql | mongo)
//   ทุก adapter ต้อง implement interface เดียวกัน:
//     ensureSchema() · appendEvent(ev) · upsertJob(job) · upsertStep(jobKey,step)
//     getJob(jobKey) · listJobs(filter) · getSteps(jobKey) · listEvents(filter) · stop()
//   MVP: มีแต่ fileStore · sql/mongo จะเติม phase ถัดไป (ใช้ dbDialect/dbManager)
const FileStore = require('./fileStore');

function createLineStore(opts = {}) {
  const type = String(opts.type || 'file').toLowerCase();
  switch (type) {
    case 'file': return new FileStore(opts);
    case 'sqlite': return new (require('./sqliteStore'))(opts);   // node:sqlite / better-sqlite3 (auto-detect) · ไฟล์เดียว
    case 'pg': case 'mssql': case 'mysql': return new (require('./sqlStore'))({ ...opts, dialect: type });
    // case 'mongo': return new (require('./mongoStore'))(opts);
    default:
      console.warn(`[lineStore] type "${type}" ยังไม่รองรับ — ใช้ file แทน`);
      return new FileStore(opts);
  }
}

module.exports = { createLineStore };
