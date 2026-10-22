#!/usr/bin/env python3
# gen-plant-gif.py — แอนิเมชันหน้า LIVE (โรงงานผสม): ไซโลวัตถุดิบ → ถังกวน (ใบพัดหมุน + ฟอง +
#   ฮีตเตอร์วูบวาบ + ไอน้ำ) → ปั๊ม (ใบพัดหมุน) → หัวบรรจุ → กระป๋องวิ่งออกทางสายพาน
#   loop เนียน: ทุกอย่างหมุน/ไหลครบรอบพอดีต่อ 1 ลูป · โทนสีเดียวกับ dashboard
import math, os
from PIL import Image, ImageDraw, ImageFont
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _scaled import ScaledDraw, scaled_image, scaled_font
S = 1.5                     # 1200 logical → 1800 จริง (canvas Full HD 1920 กว้าง) — วาด native ไม่ยืดภาพ


W, H = 1200, 170
FRAMES = 48
BG      = (10, 14, 26)
CARD    = (17, 24, 39)
LINE    = (31, 41, 55)
STEEL   = (59, 75, 102)
GREEN   = (52, 211, 153)
GREEN_D = (34, 150, 110)
BLUE    = (96, 165, 250)
AMBER   = (251, 191, 36)
GRAY    = (156, 163, 175)
CYAN    = (94, 234, 212)

FONT = scaled_font(14, S)

def flow_dots(d, pts, ph, color, spacing=26):
    # จุดวิ่งตามเส้นท่อ (pts = polyline) — เลื่อนครบ spacing ต่อลูป
    segs, total = [], 0.0
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0]-a[0], b[1]-a[1]); segs.append((a, b, L)); total += L
    off = (ph * spacing) % spacing
    s = off
    while s < total:
        acc = 0.0
        for a, b, L in segs:
            if s <= acc + L:
                t = (s - acc) / L
                x, y = a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t
                d.ellipse([x-3, y-3, x+3, y+3], fill=color)
                break
            acc += L
        s += spacing

frames = []
for f in range(FRAMES):
    ph = f / FRAMES
    im = scaled_image(W, H, S, BG)
    d = ScaledDraw(im, S)

    # ── ไซโลวัตถุดิบ (ซ้าย) ──
    d.polygon([(60, 30), (150, 30), (150, 90), (105, 120), (60, 90)], fill=CARD, outline=STEEL)
    d.rectangle([98, 120, 112, 132], fill=STEEL)
    d.text((70, 36), 'RAW', font=FONT, fill=GRAY)

    # ท่อ ไซโล → ถังกวน
    pipe1 = [(105, 132), (105, 148), (250, 148), (250, 60), (330, 60)]
    d.line(pipe1, fill=STEEL, width=6)
    flow_dots(d, pipe1, ph, GREEN)

    # ── ถังกวน (กลาง) ──
    TX0, TX1, TY0, TY1 = 330, 520, 34, 140
    d.rounded_rectangle([TX0, TY0, TX1, TY1], 14, fill=CARD, outline=STEEL, width=2)
    lvl = TY0 + 34 + 6 * math.sin(ph * 2*math.pi)            # ผิวน้ำกระเพื่อม
    d.rounded_rectangle([TX0+4, lvl, TX1-4, TY1-4], 10, fill=GREEN_D)
    # ใบพัดกวน (หมุนครบรอบต่อลูป)
    cx, cy = (TX0+TX1)//2, (TY0+TY1)//2 + 14
    d.line([cx, TY0-6, cx, cy], fill=STEEL, width=5)
    a = ph * 2*math.pi
    for k in (0, math.pi/2, math.pi, 3*math.pi/2):
        d.line([cx, cy, cx + 34*math.cos(a+k), cy + 12*math.sin(a+k)], fill=(210, 225, 240), width=4)
    # ฟองลอยขึ้น (3 สาย เฟสต่างกัน)
    for bi in range(3):
        by = TY1 - 8 - ((ph + bi/3) % 1.0) * (TY1 - lvl - 14)
        bx = TX0 + 40 + bi*55 + 6*math.sin((ph + bi/3) * 4*math.pi)
        d.ellipse([bx-4, by-4, bx+4, by+4], outline=GREEN, width=1)
    # ฮีตเตอร์วูบวาบใต้ถัง (โยงกับ "อุณหภูมิ")
    if (f // 4) % 2 == 0:
        for hx in range(TX0+24, TX1-16, 36):
            d.polygon([(hx, TY1+14), (hx+8, TY1+2), (hx+16, TY1+14)], fill=AMBER)
    d.text((TX0+52, TY0+6), 'MIX TANK', font=FONT, fill=GRAY)
    # ไอน้ำเหนือถัง (วงโตแล้วจาง — สลับ 2 ชุด)
    for si in range(2):
        sp = (ph + si/2) % 1.0
        sy, sr = TY0 - 8 - sp*18, 3 + sp*5
        if sp < 0.8:
            d.ellipse([cx-30+si*54 - sr, sy - sr, cx-30+si*54 + sr, sy + sr], outline=LINE, width=2)

    # ท่อ ถัง → ปั๊ม → หัวบรรจุ
    pipe2 = [(520, 110), (600, 110)]
    d.line(pipe2, fill=STEEL, width=6)
    flow_dots(d, pipe2, ph, GREEN)
    # ปั๊ม (ใบพัดหมุน)
    d.ellipse([600, 88, 644, 132], fill=CARD, outline=STEEL, width=2)
    pa = -ph * 4*math.pi
    for k in (0, 2*math.pi/3, 4*math.pi/3):
        d.line([622, 110, 622 + 16*math.cos(pa+k), 110 + 16*math.sin(pa+k)], fill=BLUE, width=3)
    d.text((598, 136), 'PUMP', font=FONT, fill=GRAY)
    pipe3 = [(644, 110), (780, 110), (780, 46), (860, 46)]
    d.line(pipe3, fill=STEEL, width=6)
    flow_dots(d, pipe3, ph, GREEN)

    # ── หัวบรรจุ + สายพานกระป๋อง (ขวา · โยงกับ "ชิ้นงานสะสม") ──
    d.rounded_rectangle([842, 40, 878, 64], 4, fill=CARD, outline=STEEL)
    d.polygon([(852, 64), (868, 64), (860, 76)], fill=STEEL)
    d.rectangle([760, 128, W, 131], fill=LINE)
    for i in range(0, 9):
        rx = 760 + ((i * 56 + ph * 56) % (W - 760 + 112)) - 56
        rcx = 760 + 18 + rx - 760
        if rcx < 700: continue
        can_x = rx
        filled = can_x > 872
        top = 128 - 30
        d.rounded_rectangle([can_x, top, can_x+22, 124], 3,
                            fill=(GREEN_D if filled else (13, 20, 34)), outline=(GREEN if filled else STEEL), width=2)
    if abs(((860) - 760) % 56) >= 0:   # สายน้ำตอนกระป๋องผ่านใต้หัวบรรจุ
        under = any(abs((760 + ((i*56 + ph*56) % (W - 760 + 112)) - 56 + 11) - 860) < 16 for i in range(9))
        if under:
            d.line([860, 76, 860, 96], fill=GREEN, width=3)
    for i in range(0, (W-760)//48 + 1):
        rcx, rcy, rr = 772 + i*48, 140, 8
        d.ellipse([rcx-rr, rcy-rr, rcx+rr, rcy+rr], outline=STEEL, width=2)
        ra = ph * 2*math.pi + i
        d.line([rcx - rr*math.cos(ra), rcy - rr*math.sin(ra), rcx + rr*math.cos(ra), rcy + rr*math.sin(ra)], fill=STEEL)
    d.text((900, 148), 'OUTPUT', font=FONT, fill=GRAY)

    frames.append(im.quantize(colors=64, dither=Image.Dither.NONE))

out = os.path.join(os.path.dirname(__file__), '..', 'seed', 'plantline.gif')
frames[0].save(out, save_all=True, append_images=frames[1:], duration=90, loop=0, disposal=2, optimize=True)
print(f'เขียน {os.path.abspath(out)} · {os.path.getsize(out)//1024} KB · {FRAMES} เฟรม')
