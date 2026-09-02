#!/usr/bin/env python3
# gen-packline-gif.py — วาดแอนิเมชันสายการบรรจุ (loop เนียน) สำหรับหน้า PACKAGING ของ demo
#   ขวดวิ่งบนสายพานผ่าน 4 สถานี: FILL (เติม) → CAP (ปิดฝา) → INSPECT (สแกน) → LABEL (ฉลาก)
#   ขวดเปลี่ยนสภาพตามตำแหน่ง (มีน้ำ/มีฝา/มีฉลาก) · ลูกกลิ้งหมุน · LED กะพริบ · ลำแสงสแกนกวาด
#   ผลลัพธ์: seed/packline.gif (โทนสีเดียวกับ dashboard #0A0E1A / เขียว #34D399 / ฟ้า #60A5FA)
import math, os
from PIL import Image, ImageDraw, ImageFont
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _scaled import ScaledDraw, scaled_image, scaled_font
S = 1.5                     # 1200 logical → 1800 จริง (canvas Full HD 1920 กว้าง) — วาด native ไม่ยืดภาพ


W, H = 1200, 170
FRAMES = 48
SPACING = 150                    # ระยะห่างขวด — เลื่อนครบ 1 ช่วงต่อลูป = loop เนียน
BELT_Y = 128

BG      = (10, 14, 26)
CARD    = (17, 24, 39)
LINE    = (31, 41, 55)
STEEL   = (59, 75, 102)
GREEN   = (52, 211, 153)
GREEN_D = (34, 150, 110)
BLUE    = (96, 165, 250)
AMBER   = (251, 191, 36)
GRAY    = (156, 163, 175)
WHITE   = (235, 240, 248)
CYAN    = (94, 234, 212)

STATIONS = [(260, 'FILL'), (520, 'CAP'), (780, 'INSPECT'), (1000, 'LABEL')]

FONT = scaled_font(14, S)

def draw_gantry(d, cx, lit):
    d.rounded_rectangle([cx-46, 16, cx-36, 108], 3, fill=CARD, outline=STEEL)
    d.rounded_rectangle([cx+36, 16, cx+46, 108], 3, fill=CARD, outline=STEEL)
    d.rounded_rectangle([cx-52, 8, cx+52, 26], 5, fill=CARD, outline=STEEL)
    d.ellipse([cx-5, 13, cx+5, 21], fill=(GREEN if lit else LINE), outline=STEEL)

def draw_bottle(d, x, has_liquid, has_cap, has_label):
    bw, bh = 26, 46
    top = BELT_Y - 4 - bh
    d.rounded_rectangle([x, top, x+bw, BELT_Y-4], 6, fill=(13, 20, 34), outline=GREEN, width=2)
    if has_liquid:
        d.rounded_rectangle([x+3, top+14, x+bw-3, BELT_Y-7], 4, fill=GREEN_D)
    d.rectangle([x+8, top-8, x+bw-8, top+2], fill=(13, 20, 34), outline=GREEN, width=2)
    if has_cap:
        d.rounded_rectangle([x+6, top-13, x+bw-6, top-5], 2, fill=BLUE)
    if has_label:
        d.rounded_rectangle([x+4, top+20, x+bw-4, top+34], 2, fill=WHITE)
        d.line([x+7, top+25, x+bw-7, top+25], fill=GRAY)
        d.line([x+7, top+29, x+bw-7, top+29], fill=GRAY)

frames = []
for f in range(FRAMES):
    ph = f / FRAMES
    im = scaled_image(W, H, S, BG)
    d = ScaledDraw(im, S)

    # พื้น + สายพาน
    d.rectangle([0, BELT_Y, W, BELT_Y+3], fill=LINE)
    for i in range(0, W // 60 + 2):
        cx, cy, r = 30 + i*60, BELT_Y + 18, 10
        d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=STEEL, width=2)
        a = ph * 2*math.pi + i*0.7                      # หมุนครบรอบต่อลูป
        d.line([cx - r*math.cos(a), cy - r*math.sin(a), cx + r*math.cos(a), cy + r*math.sin(a)], fill=STEEL)

    # โครงสถานี (ไฟกะพริบสลับกัน)
    for si, (cx, name) in enumerate(STATIONS):
        draw_gantry(d, cx, lit=((f // 6) + si) % 2 == 0)

    # ขวด (สภาพขึ้นกับตำแหน่ง — ผ่านสถานีไหนแล้วได้ของชิ้นนั้น)
    bottle_xs = []
    for i in range(-1, W // SPACING + 2):
        x = (i * SPACING + ph * SPACING) % (W + 2*SPACING) - SPACING
        bottle_xs.append(x)
        draw_bottle(d, x, has_liquid=x > 265, has_cap=x > 525, has_label=x > 1005)

    near = lambda cx: any(abs((x+13) - cx) < 26 for x in bottle_xs)

    # FILL: หัวจ่าย + สายน้ำตอนมีขวดอยู่ใต้
    cx = STATIONS[0][0]
    d.polygon([(cx-8, 26), (cx+8, 26), (cx, 40)], fill=STEEL)
    if near(cx):
        d.line([cx, 40, cx, BELT_Y-46], fill=GREEN, width=3)

    # CAP: ลูกสูบกดลงตอนมีขวด
    cx = STATIONS[1][0]
    press = 16 if near(cx) else 0
    d.rectangle([cx-10, 26, cx+10, 40+press], fill=STEEL)
    d.rectangle([cx-16, 40+press, cx+16, 48+press], fill=BLUE)

    # INSPECT: ลำแสงสแกนกวาดซ้าย-ขวา + เส้นเลเซอร์ลงพื้น
    cx = STATIONS[2][0]
    sweep = cx + int(34 * math.sin(ph * 2*math.pi * 2))
    d.line([sweep, 26, sweep, BELT_Y-6], fill=CYAN, width=2)
    d.ellipse([sweep-3, 24, sweep+3, 30], fill=CYAN)

    # LABEL: ลูกกลิ้งฉลากหมุน
    cx = STATIONS[3][0]
    r = 12
    d.ellipse([cx+20-r, 60-r, cx+20+r, 60+r], outline=WHITE, width=2)
    a = -ph * 2*math.pi * 2
    d.line([cx+20, 60, cx+20 + r*math.cos(a), 60 + r*math.sin(a)], fill=WHITE)

    # ป้ายชื่อสถานี
    for cx, name in STATIONS:
        tw = d.textlength(name, font=FONT)
        d.text((cx - tw/2, BELT_Y + 22), name, font=FONT, fill=GRAY)

    frames.append(im.quantize(colors=64, dither=Image.Dither.NONE))

out = os.path.join(os.path.dirname(__file__), '..', 'seed', 'packline.gif')
frames[0].save(out, save_all=True, append_images=frames[1:], duration=90, loop=0, disposal=2, optimize=True)
print(f'เขียน {os.path.abspath(out)} · {os.path.getsize(out)//1024} KB · {FRAMES} เฟรม')
