-- W192 (LIQUID_AUTO) sqlite setup — conn 'DATA' · dump จาก sqlite_master จริง 2026-08-21
-- ⚠️ ส่วนนี้อยู่ในไฟล์ DB ของเครื่อง ไม่ติดมากับ zip export — restore เครื่องใหม่ต้องรันเองทั้งไฟล์นี้
-- (ไม่รวม dl_weight_pack_rt11 — ตาราง datalog สร้างเองอัตโนมัติโดย datalog engine)

-- ── ตารางไลน์ autopack (3 ตาราง sqlite-first · sent=0 → AUTOPACK_DRAIN ส่งขึ้น .39) ──
CREATE TABLE IF NOT EXISTS BarcodeData (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, barcode_rev TEXT, fg_order TEXT, sm_order TEXT, product_name TEXT, lot_no TEXT, mfg TEXT, exp TEXT, barcode_fg TEXT, pack_size REAL, amount_tank INTEGER, amount_plan_weight REAL, rtno TEXT, plant TEXT, record_id TEXT UNIQUE, sent INTEGER DEFAULT 0, status TEXT DEFAULT 'ok', error_msg TEXT);
CREATE INDEX IF NOT EXISTS idx_bd_sent ON BarcodeData(sent);

CREATE TABLE IF NOT EXISTS RealtimeData (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, station TEXT, weig TEXT, code TEXT, record_id TEXT UNIQUE, plant TEXT, sent INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_rd_sent ON RealtimeData(sent, station);

CREATE TABLE IF NOT EXISTS FinalData (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, counter_final INTEGER, product_name_final INTEGER, lot_no_final TEXT, barcode_final TEXT, vision_ok INTEGER, vision_ng INTEGER, weight_final REAL, weight_ok INTEGER, weight_ng INTEGER, plant TEXT, record_id TEXT UNIQUE, sent INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_fd_sent ON FinalData(sent);

-- ── ตารางระบบชั่งมือเดิม (weig01/hb_check ใช้ · หน้า WEIGHT RECORD .34:7000 อ่านตรง) ──
CREATE TABLE IF NOT EXISTS kubotalog_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, station TEXT, weig TEXT, code TEXT, sent INTEGER DEFAULT 0, record_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_rid ON kubotalog_backup(record_id);
CREATE INDEX IF NOT EXISTS idx_kb_sent ON kubotalog_backup(sent, station);

-- ── trigger mirror (แก้ถาวร 2026-08-21) ──
-- ทุก INSERT ลง RealtimeData จากทางไหนก็ตาม → DB สำเนาลง kubotalog_backup เอง sent=1
-- (หน้า .34:7000 อ่าน kubotalog_backup — ห้าม DROP โดยไม่แจ้งฝั่งนั้น · ห้ามเพิ่ม INSERT ซ้ำในสคริปต์ = แถวคู่)
CREATE TRIGGER IF NOT EXISTS trg_realtime_mirror
  AFTER INSERT ON RealtimeData
  BEGIN
    INSERT INTO kubotalog_backup (ts, station, weig, code, record_id, sent)
    SELECT NEW.ts, NEW.station, NEW.weig, NEW.code, NEW.record_id, 1
    WHERE NOT EXISTS (SELECT 1 FROM kubotalog_backup WHERE record_id = NEW.record_id);
  END;

-- ── ตาราง .39 (MSSQL SOI8LOG.dbo) ที่คู่กัน — มีอยู่แล้วบน server ใช้ร่วมกัน ──
-- kubotalog   : ตารางกลางทุกสถานีชั่ง (RealtimeData drain เข้าที่นี่ · plant='LIQUID')
-- BarcodeData : 19 คอลัมน์ รวม status NVARCHAR(10) DEFAULT 'ok' + error_msg NVARCHAR(500) (เพิ่ม 2026-08-21)
-- FinalData   : 14 คอลัมน์ · ทั้งคู่ record_id NVARCHAR(50) UNIQUE + [date] DATETIME DEFAULT GETDATE() + src_ts
