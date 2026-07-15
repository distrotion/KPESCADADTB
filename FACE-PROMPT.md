# PROMPT ส่งต่อ → session ของ KPESCADASW

> วิธีใช้: เปิด session ที่ `~/Desktop/KPE PROJECT/KPESCADASW` แล้ววางข้อความในกรอบข้างล่างทั้งก้อน
> ฝั่งกล้อง (TPK-VISION-FACE) **ทำเสร็จ + ทดสอบแล้ว** ที่ session `TPK-VISION` — ไม่ต้องแก้
> สเปกเต็ม: [TPK-VISION-FACE/README.md](TPK-VISION-FACE/README.md)

---

```
งาน: ต่อกล้องจำหน้า (TPK-VISION-FACE) เข้า KPE SCADA — ส่งค่า "นี่คือใคร" + เปิดกล้องดูใน dashboard

## บริบท
มีแอป TPK-VISION-FACE (Python) เสร็จแล้ว รันบน Raspberry Pi 5 (4GB) + USB webcam ที่ประตู
จำหน้าคนได้ไม่เกิน ~20 คน (OpenCV YuNet + SFace) ทดสอบแล้วด้วยภาพจริง:
คนเดียวกัน cosine 0.46-0.79 · คนแปลกหน้า -0.099 · threshold 0.42 แยกได้ชัด

สเปกฝั่งกล้องเต็ม ๆ (อ่านก่อนเริ่ม):
/Users/administrator/TPK/QC/ALL-REFRESH-NEW/TPK-VISION/TPK-VISION-FACE/README.md

Pi เปิด 3 อย่าง:
  - MQTT publish  → tpk/vision/face/gate1         (retain) {"id":7,"name":"somchai","conf":92}
  - MQTT publish  → tpk/vision/face/gate1/enroll  (retain) ความคืบหน้าตอนแอดคน + text ไทยสำเร็จรูป
  - HTTP :8099    → GET /  หน้าเว็บภาพสด · POST /enroll สั่งแอดคน · DELETE /people/{id}

## Topology ที่จะทำ

  [Pi 5 ที่ประตู]                                      [KPE ตัวหลัก]
   TPK-VISION-FACE ──MQTT──► mosquitto ──► KPE node ──kpenetwork──► KPE main
   (:8099)                   (:1883)       (:3012)                    │
      └────────────────── embed widget (http://<pi-ip>:8099/) ─────────┘

Pi รัน KPE node ของตัวเอง แล้วแชร์ tag ขึ้นเครือผ่าน kpenetwork ตามที่ออกแบบไว้ใน
docs/KPENETWORK-DEVICE-TYPE.md — ฝั่งกล้องไม่รู้จัก kpenetwork เลย มันแค่ยิง MQTT

## ⚠️ งานที่ 1 — เพิ่มช่อง topic/jsonPath ในฟอร์ม tag ของ mqtt (ต้องทำก่อนอย่างอื่น)

ตรวจโค้ดแล้วพบว่า **ทางนี้มี driver แต่ยังไม่เคยถูกใช้จริง**:
  - backend/src/drivers/mqttDriver.js:10-14 สร้าง topicMap จาก `tag.topic`
    และอ่าน `tag.jsonPath` (บรรทัด 46-48)
  - แต่ **frontend ไม่มีช่องให้กรอก topic หรือ jsonPath เลย** (grep ทั้ง frontend/lib
    เจอ jsonPath เฉพาะใน query_buffer_screen.dart ซึ่งเป็นคนละฟีเจอร์)
  - config/devices.json ไม่มี mqtt device สักตัว (มีแค่ virtual/mc_protocol/serial_bridge)
  - backend/test/ ไม่มี test mqtt เลย

ต้องทำ:
  - tag_management_screen.dart — เพิ่มช่องเมื่อ device type = mqtt:
      topic (บังคับ) · jsonPath · qos · retain · writeTopic (มี writeTag แล้ว ดู SESSION-HANDOFF §1095)
  - ระวัง: tag ที่ไม่มี topic จะกลายเป็น topicMap[undefined] ทับกันเงียบ ๆ → validate ว่าต้องมี
    และห้าม topic ซ้ำกันใน device เดียว
  - device form (Broker URL / Client ID / Username / Password) **มีอยู่แล้ว**
    ที่ devices_screen.dart:1215 — ไม่ต้องแก้
  - เขียน test: backend/test/mqtt.test.js (ยิง broker จำลอง → tag ได้ค่า, jsonPath แกะถูก)

## งานที่ 2 — ติดตั้ง KPE บน Pi 5

installer/pi/install_pi.sh มีอยู่แล้ว แต่ docs/INSTALL-PI.md เขียนเองว่า
"validate syntax/help/OS-guard/unit-render บน Mac · **เหลือรันจริงบน Pi 5**"
→ งานนี้คือการ validate installer ครั้งแรกบนเครื่องจริง เจอปัญหาให้แก้ที่ installer

  - ห้ามก๊อป node_modules จากเครื่องอื่น (serialport เป็น native) — npm install บน Pi เสมอ
  - ต้องมี mosquitto (installer ของฝั่งกล้องลงให้แล้วถ้ารัน install_pi.sh ของ TPK-VISION-FACE)
  - ถ้าจะใช้ GPIO ด้วย: Pi 5 = gpiochip4 ไม่ใช่ gpiochip0

## งานที่ 3 — mqtt device + 3 tags บน KPE node ที่ Pi

device:  type=mqtt · broker=mqtt://127.0.0.1:1883 (mosquitto เครื่องเดียวกัน)
tags:    ทั้ง 3 ตัวชี้ topic เดียวกัน = tpk/vision/face/gate1 ต่างกันที่ jsonPath

  | tag         | dataType | topic                          | jsonPath |
  |-------------|----------|--------------------------------|----------|
  | person_id   | INT16    | tpk/vision/face/gate1          | id       |
  | person_name | STRING   | tpk/vision/face/gate1          | name     |
  | person_conf | INT16    | tpk/vision/face/gate1          | conf     |
  | enroll_msg  | STRING   | tpk/vision/face/gate1/enroll   | text     |

(enroll_msg ใช้ในงานที่ 7 — bind label ตรง ๆ ได้เลย ฝั่งกล้องแปลงเป็นข้อความไทยมาให้แล้ว)

⚠️ **person_id มี 3 ความหมาย — ห้าม map รวมกัน**
  |  1..20 | คนในทะเบียน            | เปิดประตู / log คนเข้า
  |  -1    | มีคนอยู่ แต่ไม่รู้จัก   | ← ปลุก alarm คนแปลกหน้า (งานที่ 6)
  |  0     | ไม่มีใครอยู่หน้ากล้อง   | เงียบ

⚠️ **ต้องเป็น INT16 (signed) ไม่ใช่ UINT16** — ไม่งั้น -1 จะกลายเป็น 65535 แล้ว alarm พัง

⚠️ ฝั่งกล้องส่ง **retain=True** ตั้งใจ — KPE restart แล้วได้ค่าล่าสุดทันทีโดยไม่ต้องรอ
   คนเดินผ่านกล้องใหม่ อย่าตั้ง client ให้ทิ้ง retained message

## งานที่ 4 — แชร์ขึ้น kpenetwork

  - ติ๊ก "แชร์เข้าเครือข่าย (KPENETWORK)" ทั้ง 3 tag
  - ที่ KPE ตัวหลัก: เพิ่ม device type kpenetwork ชี้ Pi (host + modbusPort + apiPort)
  - **person_name เป็น STRING → kpenetworkServer.js:106 จะ auto-route ไป REST transport
    (area:'rest') และเป็น read-only ตามดีไซน์ v1 — นี่คือพฤติกรรมที่ถูกต้อง ไม่ใช่บั๊ก อย่าไปแก้**
  - REST transport อัปเดตช้ากว่า Modbus → **ตรรกะทุกอย่าง (alarm/script/interlock) ผูกกับ
    person_id เท่านั้น** · person_name ไว้แสดงผลบน dashboard เฉย ๆ
  - security: เปิด requireApiKey + ตั้ง allowIps (§9.5 บอกเองว่า Modbus data plane ไม่มี auth เลย)
  - (ทางเลือก) ถ้า transport ws (§76 / docs/KPENETWORK-WS.md) พร้อมใช้แล้ว ลองดูว่าทำให้
    STRING มา realtime ขึ้นไหม — ไม่บังคับ ค่อยทำทีหลังได้

## งานที่ 5 — เปิดกล้องดูใน dashboard

เพิ่ม widget **Web Embed** (มีอยู่แล้ว — embed_widget.dart) url:

    http://<pi-ip>:8099/

⚠️ **ใส่ `/` ไม่ใช่ `/stream`** — ทดสอบใน Chrome จริงแล้ว: iframe ชี้ /stream เล่นได้ก็จริง
   แต่ browser แสดงภาพขนาดจริง 1280x720 ไม่ย่อตามกรอบ widget → เห็นแค่มุมซ้ายบน (เพดาน)
   หน้า / มี <img style="width:100%"> ครอบให้ = ย่อพอดีทุกขนาด + มีป้ายชื่อคนด้านบนแถม

  - ไม่ต้องเปิด option `proxy` (เป็น HTTP ธรรมดา ไม่มี X-Frame-Options)
  - **อย่าเปลี่ยนไปใช้ RTSP** — browser เล่น rtsp:// ไม่ได้ และ Pi 5 ตัด hardware H.264
    encoder ออกไปแล้ว (ต่างจาก Pi 4) MJPEG ถูกเลือกเพราะเหตุนี้
  - หมายเหตุ: MJPEG เป็น stream ที่ไม่มีวันโหลดจบ → page load event ไม่ยิง
    ถ้าเขียนเทส automation อย่ารอ load event (เจอมาแล้ว navigate timeout 300 วิ)

## งานที่ 6 — alarm คนแปลกหน้า

person_id == -1 ต่อเนื่องเกิน N วินาที → alarm "มีคนแปลกหน้าที่ประตู"
(ฝั่งกล้อง debounce มาให้แล้วระดับหนึ่ง: ต้องเห็นคนเดิมติดกัน 3 เฟรมก่อนประกาศ
 และไม่เห็นหน้า 2 วิ ถึงจะกลับเป็น 0 — ไม่ต้อง debounce ซ้ำหนัก ๆ อีก)

## งานที่ 7 — ลงทะเบียนคนจากหน้า KPE (ผู้ใช้ขอ — "ลงทะเบียนผ่าน KPESCADA ได้ด้วยมั้ย")

ทำได้ **โดยไม่ต้องแก้ backend ของ KPE เลย** เพราะ scriptEngine.js มี httpPost() ในตัวอยู่แล้ว
(บรรทัด 582 — httpGet/httpPost/httpRequest ครบ) และ button widget มี mode=script ที่ยิง
run_script → runOnce() อยู่แล้ว (button_widget.dart:157 · **runOnce รันได้แม้ script ตั้ง
enabled=false** — ตั้ง enabled=false ไว้เลย กัน trigger อื่นรันเอง)

### ของที่ต้องสร้างก่อน
  - virtual device id `ui` (type=virtual) + tag `enroll_name` STRING — ที่พักชื่อที่พิมพ์
  - mqtt tag `enroll_msg` (งานที่ 3) — label อ่านความคืบหน้าจากตัวนี้
  - เวิร์กโฟลว์จริง: **คนใหม่ไปยืนหน้ากล้องที่ Pi** · เจ้าหน้าที่พิมพ์ชื่อ+กดปุ่มที่จอ KPE
    (KPE ส่งรูปไปให้ Pi ไม่ได้ — embed widget เป็นการดูทางเดียว หน้าต้องมาจากกล้องจริง)

### Layout หน้า "ลงทะเบียนใบหน้า" (deck ใหม่ 1 หน้า)

  ┌─────────────────────────────────────────────────────────────┐
  │  [label]   "ลงทะเบียนใบหน้า — gate1"        (หัวข้อ, static) │
  │                                                              │
  │  [embed]   url=http://<pi-ip>:8099/          w≈480 h≈360     │
  │            (คนที่มาแอดเห็นหน้าตัวเอง + กรอบ ระหว่างเก็บภาพ)  │
  │                                                              │
  │  [textinput] bind ui/enroll_name             w≈240           │
  │            hint "ชื่อพนักงาน" · โหมด Enter/SET ก็ได้          │
  │                                                              │
  │  [button]  "เริ่มแอดคน" mode=script → scriptId=face_enroll   │
  │                                                              │
  │  [label]   bind <mqtt-device>/enroll_msg     w≈420           │
  │            ← โชว์ "กำลังเก็บภาพ 3/5 — มองกล้อง" → "✓ เพิ่ม…" │
  │            (ฝั่งกล้องแปลงเป็นข้อความไทยให้แล้วใน field text   │
  │             ไม่ต้องเขียน script แปลงสถานะ)                    │
  │                                                              │
  │  [label]   bind <mqtt-device>/person_name    (ทดสอบ: แอดเสร็จ│
  │             ยืนหน้ากล้อง ชื่อต้องขึ้นตรงนี้)                  │
  └─────────────────────────────────────────────────────────────┘

### Script `face_enroll` (enabled=false · trigger อะไรก็ได้ ไม่ถูกใช้ — ปุ่มเรียก runOnce ตรง)

    // เริ่มแอดคน: อ่านชื่อจาก textinput → สั่งกล้องที่ Pi → คืนทันที
    // ความคืบหน้าไม่ต้อง poll ที่นี่ — Pi ยิงมาเองทาง MQTT (tag enroll_msg)
    const PI = 'http://<pi-ip>:8099';
    const name = String(tag('ui', 'enroll_name') ?? '').trim();
    if (!name) { notify('พิมพ์ชื่อก่อนกดแอด', 'warning'); return; }

    const res = await httpPost(PI + '/enroll', { name });
    // httpPost ไม่ throw ตอน HTTP 4xx — FastAPI ตอบ error เป็น {detail: "..."}
    if (res && res.detail)      notify('แอดไม่ได้: ' + res.detail, 'error');       // 409 = กำลังแอดคนอื่น
    else if (res && res.ok)     notify('เริ่มเก็บภาพ "' + name + '" — ให้ยืนมองกล้อง', 'info');
    else                        notify('กล้องไม่ตอบ (' + PI + ') เช็ค service ที่ Pi', 'error');

### (ทางเลือก) Script `face_remove` — ปุ่มลบคน

    // ลบคนตาม id ใน tag ui/remove_id (สร้าง virtual tag INT16 + numeric input เพิ่ม)
    const PI = 'http://<pi-ip>:8099';
    const pid = Number(tag('ui', 'remove_id') || 0);
    if (pid < 1) { notify('ใส่ id ที่จะลบก่อน (ดูจาก GET /people)', 'warning'); return; }
    const res = await httpRequest(PI + '/people/' + pid, { method: 'DELETE' });
    if (res && res.ok) notify('ลบ id ' + pid + ' แล้ว', 'info');
    else               notify('ลบไม่ได้: ' + JSON.stringify(res), 'error');

    // รายชื่อทั้งหมดดึงได้จาก httpGet(PI + '/people') → {count, people:[{id,name,shots}]}
    // จะโชว์เป็นตารางก็เอาไปเขียนลง buffer แล้วใช้ db_table ตามแพตเทิร์นเดิมของโปรเจกต์

### กติกาที่ห้ามพลาด
  - ⚠️ **ห้ามให้ script รอ enroll จนจบ** — POST /enroll คืนทันทีอยู่แล้ว (วัดจริง ~2ms)
    **ห้ามเปลี่ยนไปใช้ /enroll?wait=1 ใน script เด็ดขาด**: wait=1 บล็อกถึง 25 วิ แต่ script
    ของ KPE timeout 5 วิ (scriptEngine.js:69) + circuit breaker ปิด script ถาวรหลัง timeout
    ติดกัน 3 ครั้ง (maxTimeoutHits) → ปุ่มแอดจะพังแบบเงียบ ๆ
  - enroll_msg เป็น retained message — เปิดหน้ามาจะเห็นผลของรอบก่อนค้างอยู่ ("✓ เพิ่ม…")
    ถือเป็นพฤติกรรมถูก (บอกว่าล่าสุดทำอะไรไป) ไม่ใช่บั๊ก
  - แอดซ้อนไม่ได้ — Pi ตอบ 409 มาเอง (script ข้างบน handle แล้วผ่าน res.detail)

ต้องมีก่อน: งานที่ 1 (ช่อง topic/jsonPath) เพราะ enroll_msg ก็เป็น mqtt tag เหมือนกัน

## ห้ามทำ
  - **ห้ามเพิ่ม dep ของ vision (opencv/onnx/numpy) เข้า KPE** — ขัดหลัก "ไม่มี dep ใหม่"
    ที่ KPENETWORK-DEVICE-TYPE.md §1 ตั้งไว้เอง และจะไปโผล่ในทุก install ทั้ง Windows/Mac/Pi
    ที่ไม่มีกล้อง · เหตุผลเต็มอยู่ใน TPK-VISION-FACE/README.md
  - ห้ามให้ KPE เปิด/อ่านกล้องเอง — กล้องเป็นของ service Python ตัวเดียว
  - ห้ามทำ device type ใหม่ชื่อ vision ตอนนี้ — mqtt + embed พอแล้ว
    (ค่อยทำเป็น thin driver แบบ gpioDriver ทีหลังถ้าอยากได้ฟอร์มตั้งค่าสวย ๆ)

## ความปลอดภัย — อ่านก่อนเปิดออกนอก localhost
  - docs/AUDIT-2026-06-06.md = **6 CRITICAL auth/RCE ยังค้าง**
  - ข้อมูลใบหน้าเป็น biometric — โฟลเดอร์ faces/ บน Pi ห้ามหลุดออกนอกเครือข่ายโรงงาน
  - API :8099 กับ MQTT :1883 ของฝั่งกล้อง **ยังไม่มี auth** ออกแบบมาให้อยู่ใน LAN ที่เชื่อถือเท่านั้น

## เสร็จแล้วพิสูจน์ยังไง
  1. ยืนหน้ากล้อง → Tag Monitor ที่ KPE ตัวหลักเห็น person_id = เลขของตัวเอง + person_name
  2. เดินออก → person_id = 0 ภายใน ~2 วิ
  3. ให้คนที่ไม่ได้ลงทะเบียนยืน → person_id = -1 → alarm ขึ้น
  4. widget โชว์ภาพสดเห็นหน้าตัวเอง + กรอบเขียวพร้อมชื่อ
  5. ปิด service กล้อง (systemctl stop tpk-vision-face) → device __online = false
  6. restart KPE → person_id กลับมาทันทีจาก retained message ไม่ต้องรอคนเดินผ่าน
  7. พิมพ์ชื่อในหน้า KPE + กดปุ่มแอด → label โชว์ "กำลังเก็บภาพ 1/5…5/5" แล้ว "✓ เพิ่มแล้ว"
     → เดินไปยืนหน้ากล้อง → person_id ขึ้นเป็นเลขของคนที่เพิ่งแอด
```
