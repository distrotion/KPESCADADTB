#!/usr/bin/env python3
# gen-layout.py — สร้าง seed/layout-dashboard.json ทั้งก้อน (แหล่งความจริงเดียวของผังหน้าจอ demo)
#   canvas Full HD 1920x1080 ทุกหน้า ยกเว้นหน้า REPORT = A4 แนวตั้ง (ใบรายงานพิมพ์จริงได้)
#   รูปแอนิเมชันฝังเป็น data-url จาก seed/*.gif (สร้างด้วย gen-*-gif.py — native 1800px ไม่ยืด)
#   แก้ผังที่นี่แล้วรันใหม่ อย่าไปแก้ JSON มือ (designer autosave จะทับ ถ้าเปิดค้างไว้)
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, '..', 'seed')

W, H = 1920, 1080                      # Full HD ทุกหน้า (ยกเว้น report)
A4_W, A4_H = 1240, 1754                # A4 แนวตั้ง @150dpi — ใบรายงานพิมพ์ออกมาได้พอดี

BG    = 4278845978    # #0A021A
CARD  = 4279310375
BLUE  = 4284524026
GREEN = 4281652121
AMBER = 4294688548
RED   = 4294473073
TANK  = 419430399


def dataurl(name):
    with open(os.path.join(SEED, name), 'rb') as f:
        return 'data:image/gif;base64,' + base64.b64encode(f.read()).decode()


def page(pid, name, widgets, w=W, h=H, run_fit="contain"):
    # run_fit: contain = ย่อให้พอดีจอ (หน้า dashboard) · scroll = ขนาดจริง ไม่ขยาย (หน้า A4 — ใบต้องได้สัดส่วนจริง)
    return {"id": pid, "name": name, "canvasW": w, "canvasH": h,
            "canvasBg": BG, "canvasBgImage": None, "canvasBgFit": "cover",
            "runFit": run_fit, "deviceClass": "desktop",
            "runShowLogo": True, "runShowTags": True, "widgets": widgets}


def nav(wid, label, target, x, y, w=170, h=56, fs=15):
    return {"id": wid, "type": "nav", "x": x, "y": y, "w": w, "h": h,
            "config": {"label": label, "targetPageId": target, "fontSize": fs}}


def num(wid, tag, label, unit, x, y, w, h, color=BLUE, fs=44):
    return {"id": wid, "type": "numeric", "x": x, "y": y, "w": w, "h": h,
            "config": {"deviceId": "DEMO01", "tagId": tag, "label": label, "unit": unit,
                       "decimals": 0, "fontSize": fs, "showLabel": True, "color": color,
                       "borderColor": BLUE, "borderWidth": 1, "bgColor": CARD}}


def gauge(wid, tag, label, mn, mx, x, y, w, h, color):
    return {"id": wid, "type": "gauge", "x": x, "y": y, "w": w, "h": h,
            "config": {"deviceId": "DEMO01", "tagId": tag, "label": label, "min": mn, "max": mx,
                       "decimals": 0, "color": color, "bgColor": CARD, "fontSize": 38, "labelSize": 18}}


def level(wid, tag, label, x, y, w, h):
    return {"id": wid, "type": "level", "x": x, "y": y, "w": w, "h": h,
            "config": {"deviceId": "DEMO01", "tagId": tag, "label": label, "min": 0, "max": 100,
                       "unit": "%", "decimals": 0, "showValue": True, "showPercent": True,
                       "showLabel": True, "tankColor": TANK, "color": BLUE,
                       "borderColor": BLUE, "borderWidth": 1}}


def lamp(wid, tag, label, x, y, w, h, on_lbl, off_lbl, off_color=RED):
    return {"id": wid, "type": "indicator", "x": x, "y": y, "w": w, "h": h,
            "config": {"deviceId": "DEMO01", "tagId": tag, "label": label, "lampStyle": "classic",
                       "onColor": GREEN, "offColor": off_color, "onLabel": on_lbl, "offLabel": off_lbl}}


def label(wid, text, x, y, w, h, fs):
    return {"id": wid, "type": "label", "x": x, "y": y, "w": w, "h": h,
            "config": {"text": text, "fontSize": fs}}


def image(wid, url, x, y, w, h):
    return {"id": wid, "type": "image", "x": x, "y": y, "w": w, "h": h,
            "config": {"image": url, "fit": "contain", "radius": 12, "opacity": 100, "bgColor": 0}}


# ══ หน้า 1 · LIVE OVERVIEW ══════════════════════════════════════════════════
p1 = [
    label("w_demo_title", "DEMO PLANT — LIVE OVERVIEW", 60, 34, 1000, 66, 44),
    nav("w_demo_nav_report", "ใบรายงาน", "report", 1080, 40),
    nav("w_demo_nav_pack",   "แพ็คกิ้ง",  "packing", 1262, 40),
    nav("w_demo_nav_chem",   "ไลน์ชุบ",   "lineanim", 1444, 40),
    lamp("w_demo_link", "__online", "PLC LINK", 1650, 36, 220, 64, "ONLINE", "OFFLINE"),

    gauge("w_demo_g_temp",  "temp",  "อุณหภูมิ (°C)",           0, 120,  60, 138, 380, 320, AMBER),
    gauge("w_demo_g_speed", "speed", "ความเร็วสายพาน (rpm)",   0, 2000, 470, 138, 380, 320, BLUE),
    level("w_demo_tank", "level", "ถังเก็บ", 880, 138, 175, 320),

    num("w_demo_n_press",  "pressure", "ความดัน",      "kPa", 1090, 138, 385, 150, BLUE),
    num("w_demo_n_count",  "counter",  "ชิ้นงานสะสม",  "pcs", 1490, 138, 380, 150, GREEN),
    num("w_demo_n_recipe", "recipe",   "สูตรที่ผลิต",   "",    1090, 308, 385, 150, AMBER),
    num("w_demo_n_temp",   "temp",     "อุณหภูมิ",      "°C",  1490, 308, 380, 150, AMBER),

    image("w_demo_anim", dataurl("plantline.gif"), 60, 490, 1800, 255),

    {"id": "w_demo_chart", "type": "chart", "x": 60, "y": 770, "w": 1800, "h": 280,
     "config": {"chartType": "line", "dataSource": "buffer", "maxPoints": 180,
                "series": [
                    {"device": "DEMO01", "tag": "temp",     "label": "อุณหภูมิ (°C)",  "color": AMBER},
                    {"device": "DEMO01", "tag": "pressure", "label": "ความดัน (kPa)", "color": BLUE},
                    {"device": "DEMO01", "tag": "level",    "label": "ระดับถัง (%)",  "color": GREEN}]}},
]

# ══ หน้า 2 · PACKAGING ══════════════════════════════════════════════════════
STN = [("unscramble", "จัดเรียงขวด"), ("fill", "นับ/บรรจุ"), ("cap", "ปิดฝา"), ("inspect", "ตรวจสอบ"),
       ("label", "ติดฉลาก"), ("carton", "บรรจุกล่อง"), ("casepack", "หีบห่อ"), ("palletize", "พาเลท")]
p2 = [
    label("w_pk_title", "PACKAGING LINE — สายการบรรจุ", 60, 30, 1000, 60, 40),
    nav("w_pk_nav_live", "หน้า LIVE", "demo",     1500, 34),
    nav("w_pk_nav_rep",  "ใบรายงาน",  "report",   1690, 34),
]
for i, (sid, lbl) in enumerate(STN):
    p2.append(lamp(f"w_pk_st_{sid}", f"pk_st_{sid}", lbl, 60 + i * 227, 116, 210, 78, "RUN", "STOP"))
p2 += [
    image("w_pk_anim", dataurl("packline.gif"), 60, 214, 1800, 255),

    gauge("w_pk_gauge", "pk_speed", "ความเร็วไลน์ (ขวด/นาที)", 0, 120, 60, 494, 370, 300, GREEN),
    level("w_pk_hopper", "pk_hopper", "ถังพักขวด", 450, 494, 160, 300),
    num("w_pk_n_fill",   "pk_filled",  "บรรจุสะสม", "ขวด",   635, 494, 360, 142, GREEN),
    num("w_pk_n_carton", "pk_cartons", "กล่องสะสม", "กล่อง", 1010, 494, 360, 142, BLUE),
    num("w_pk_n_pallet", "pk_pallets", "พาเลทสะสม", "พาเลท", 1385, 494, 375, 142, AMBER),
    num("w_pk_n_reject", "pk_reject",  "คัดออก (จุดตรวจสอบ)", "ขวด", 635, 652, 360, 142, RED),
    label("w_pk_lbl_note", "12 ขวด = 1 กล่อง · 48 กล่อง = 1 พาเลท · ความแม่นยำ >99.8%",
          1010, 672, 750, 100, 22),

    {"id": "w_pk_chart", "type": "chart", "x": 60, "y": 812, "w": 1800, "h": 238,
     "config": {"chartType": "line", "dataSource": "buffer", "maxPoints": 240,
                "series": [{"device": "DEMO01", "tag": "pk_speed",
                            "label": "ความเร็วไลน์ (ขวด/นาที)", "color": GREEN}]}},
]

# ══ หน้า 3 · CHEM LINE (ข้อมูลสดจาก Line Recorder) ══════════════════════════
TANKS = ["LOAD", "DEGREASE 1", "DEGREASE 2", "PLATE 1", "PLATE 2", "UNLOAD"]
p3 = [
    label("w_la_title", "CHEM LINE — ไลน์ชุบ (ข้อมูลสดจาก Line Recorder)", 60, 30, 1200, 60, 38),
    nav("w_la_nav_live", "หน้า LIVE", "demo",    1500, 34),
    nav("w_la_nav_pack", "แพ็คกิ้ง",   "packing", 1690, 34),
    # widget อนิเมชันจริง (lr_line_anim): รถยกตัวเดียว ยก-ย้าย-วางตามการเปลี่ยนของ lr_pos1-6
    #   แทน GIF ประดับตัวเดิม — ภาพบนจอ "คือ" ข้อมูล Line Recorder ไม่ใช่แค่ฉากประกอบ
    {"id": "w_la_anim", "type": "lr_line_anim", "x": 60, "y": 110, "w": 1800, "h": 390,
     "config": {"deviceId": "DEMO01", "tagPrefix": "lr_pos", "bays": 6,
                "labels": ["LOAD", "DEGREASE 1", "DEGREASE 2", "PLATE 1", "PLATE 2", "UNLOAD"],
                "kinds": ["dock", "blue", "blue", "green", "green", "dock"]}},
]
for i, name in enumerate(TANKS):
    x = 60 + i * 304
    p3.append(lamp(f"w_la_ind{i+1}", f"lr_pos{i+1}", name, x, 530, 280, 74,
                   "มีงาน", "ว่าง", off_color=3430880869))
    p3.append(num(f"w_la_num{i+1}", f"lr_pos{i+1}", "carrier", "", x, 618, 280, 130, AMBER))
p3.append(label("w_la_note",
                "ตำแหน่งจริงจากไลน์ชุบ Chem1 — ตัวเลขคือหมายเลข carrier ที่อยู่ในบ่อ (0 = ว่าง) · อัปเดตทุก ~5 วินาที",
                60, 790, 1500, 60, 22))

# ══ หน้า 4 · REPORT (A4 แนวตั้ง) ════════════════════════════════════════════
#   ใบรายงานเต็มหน้า A4 — เผื่อขอบบน/ล่างให้ปุ่มนำทาง แล้วที่เหลือเป็นตัวใบ (Export A4 ออกมาพอดีหน้า)
p4 = [
    nav("w_rep_nav_back", "หน้า LIVE", "demo",     A4_W - 400, 24, 180, 52, 14),
    nav("w_rep_nav_pack", "แพ็คกิ้ง",   "packing",  A4_W - 208, 24, 180, 52, 14),
    {"id": "w_rep_main", "type": "lr_job_report", "x": 30, "y": 92,
     "w": A4_W - 60, "h": A4_H - 130,
     "config": {"lineId": "CHEM1", "keyField": "carrier", "keyLabel": "Carrier",
                "pickerMode": "both", "title": "ใบรายงานผลการผลิต — DEMO PLANT"}},
]

layout = {"version": 2, "pageIndex": 0, "runStartPage": "demo",
          "pages": [page("demo", "DEMO PLANT", p1),
                    page("packing", "PACKAGING", p2),
                    page("lineanim", "CHEM LINE", p3),
                    page("report", "REPORT (A4)", p4, A4_W, A4_H, run_fit="scroll")],
          "popupPages": [], "deployViews": []}

out = os.path.join(SEED, 'layout-dashboard.json')
json.dump(layout, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
mb = os.path.getsize(out) / 1024 / 1024
print(f'เขียน {out} · {mb:.1f} MB · {len(layout["pages"])} หน้า '
      f'({W}x{H} · report {A4_W}x{A4_H} A4)')
