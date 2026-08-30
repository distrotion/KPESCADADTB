// plcMem/writer.js — เขียน PLC จริง (จุดเสี่ยงสุดของ PLCMEM — ห้ามลัดขั้นตอน)
//   ลำดับ: confirm required → write-gate (ถ้าตั้งไว้) → diff → groupRuns(≤writeMaxWords)
//          → ต่อ run: writeBlock → read-back เทียบรายตัว → verified ค่อย UPSERT buffer01
//          → ไม่ verified/throw = หยุดทั้งงานทันที ห้ามเขียน run ถัดไปต่อ
//   ไม่ใช้ engine.writeBlock (cap 60 + validate เพื่อ tag path) — เรียก driver ตรง เพราะเรามี cap
//   ของตัวเอง (writeMaxWords) และต้องคุม read-back เอง (ดู blueprint T5)
//   driver ที่รับมาต้องเป็น "ตัวเดียวกับ sweeper" เสมอ (ผ่าน sweeper.getDriver()) — MC 3E ไม่มี
//   transaction id ต้อง serialize บน socket เดียว (driver._txChain คุมให้เองถ้าใช้ instance เดียวกัน)

// อ่านค่า tag gate จาก engine — รูปแบบ "deviceId/tagId" · คืน true เมื่อค่า truthy
function _readGate(engine, writeGateTag) {
  const s = String(writeGateTag || '');
  const idx = s.indexOf('/');
  if (idx < 0) return false;
  const deviceId = s.slice(0, idx);
  const tagId = s.slice(idx + 1);
  if (!engine || typeof engine.getTagValue !== 'function') return false;
  const tv = engine.getTagValue(deviceId, tagId);
  return !!(tv && tv.value);
}

// เทียบ readback (UINT16[]) กับ words ที่สั่งเขียนไป — ต้องยาวเท่ากันและตรงทุกตัว
function _verifyReadback(words, readback) {
  if (!Array.isArray(readback) || readback.length !== words.length) return false;
  for (let i = 0; i < words.length; i++) if (readback[i] !== words[i]) return false;
  return true;
}

// writeDiff(ctx) — ctx: { plc, driver, store, engine, confirm, actor, actorType, ip }
//   คืน { ok:true, written, runs } หรือโยน Error({code}) สำหรับ precondition (NEED_CONFIRM/GATE_CLOSED)
//   คืน { ok:false, wrote, failedAt, verified:false, error } เมื่อ write กลางทางล้ม (ไม่ throw — เป็นผลลัพธ์ปกติของงาน)
async function writeDiff({ plc, driver, store, engine, confirm, actor, actorType, ip }) {
  if (confirm !== true) {
    throw Object.assign(new Error('confirm ต้องเป็น true'), { code: 'NEED_CONFIRM' });
  }

  // เช็ค gate ก่อนเริ่มทั้งงาน — ปิดตั้งแต่แรก = precondition fail (throw/409) ไม่ใช่ผลของงานที่ทำไปแล้ว
  if (plc.writeGateTag && !_readGate(engine, plc.writeGateTag)) {
    try {
      await store.journal(plc.bufferConn, {
        plc: plc.deviceId, action: 'write_gate_blocked', detail: `writeGateTag=${plc.writeGateTag}`, actor, actorType, ip,
      });
    } catch (_) {}
    throw Object.assign(new Error('write-gate closed'), { code: 'GATE_CLOSED' });
  }

  const diff = await store.diff(plc.bufferConn, plc.deviceId);
  if (!diff.length) return { ok: true, written: 0, runs: [] };
  const runs = store.groupRuns(diff, plc.writeMaxWords);

  const wrote = [];
  for (const run of runs) {
    // ⚠️ TOCTOU: gate เช็คครั้งเดียวก่อน loop ไม่พอ — diff ที่มีหลาย run แต่ละ run คือ PLC round-trip
    //   (อาจกินหลายวินาทีรวมกัน) ถ้า gate ปิดกลางทาง (พอดีเป็นสถานการณ์ที่ gate มีไว้ป้องกัน) ต้องหยุดทันที
    //   ไม่ใช่เขียนต่อไปเรื่อย ๆ — เช็คซ้ำก่อนทุก run (run แรกเช็คซ้ำกับด้านบนก็ไม่เสียหาย เพราะ gate ไม่ทันเปลี่ยนใน sync code)
    if (plc.writeGateTag && !_readGate(engine, plc.writeGateTag)) {
      const errMsg = 'write-gate closed';
      try {
        await store.journal(plc.bufferConn, {
          plc: plc.deviceId, action: 'write_gate_blocked',
          detail: `gate ปิดกลางทาง @${run.area}${run.start} (สำเร็จไปก่อนหน้า ${wrote.length} run)`, actor, actorType, ip,
        });
      } catch (_) {}
      return { ok: false, wrote, failedAt: { area: run.area, start: run.start }, verified: false, error: errMsg };
    }

    let writeErr = null;
    try { await driver.writeBlock(run.area, run.start, run.words); }
    catch (e) { writeErr = e; }

    let readback = null;
    let verified = false;
    if (!writeErr) {
      try { readback = await driver.readBlock(run.area, run.start, run.words.length); }
      catch (e) { readback = null; }
      verified = _verifyReadback(run.words, readback);
    }

    if (writeErr || !verified) {
      const errMsg = writeErr ? writeErr.message : 'read-back ไม่ตรงกับค่าที่เขียน (write ไม่ verify)';
      try {
        await store.journal(plc.bufferConn, {
          plc: plc.deviceId, action: 'write_fail',
          detail: `${run.area}${run.start} x${run.words.length}: ${errMsg}`, actor, actorType, ip,
        });
      } catch (_) {}
      return {
        ok: false,
        wrote,                                          // runs ที่เขียน+verify สำเร็จก่อนหน้าตัวนี้
        failedAt: { area: run.area, start: run.start },
        verified: false,
        error: errMsg,
      };
    }

    // verified → sync buffer01 ให้ตรงกับที่เพิ่งยืนยันจริงจาก PLC (ไม่ใช่ค่าจาก buf2 เฉย ๆ — เผื่อ driver echo คนละค่า แต่ verify แล้วต้องเท่ากันอยู่ดี)
    const rows = run.words.map((v, i) => ({ area: run.area, addr: run.start + i, value: v }));
    await store.upsertBatch(plc.bufferConn, plc.deviceId, 1, rows);
    wrote.push({ area: run.area, start: run.start, words: run.words.length });
    try {
      await store.journal(plc.bufferConn, {
        plc: plc.deviceId, action: 'write_ok', detail: `${run.area}${run.start} x${run.words.length}`, actor, actorType, ip,
      });
    } catch (_) {}
  }

  return { ok: true, written: wrote.reduce((n, r) => n + r.words, 0), runs: wrote };
}

module.exports = { writeDiff };
