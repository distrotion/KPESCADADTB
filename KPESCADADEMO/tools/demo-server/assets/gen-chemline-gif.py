#!/usr/bin/env python3
# gen-chemline-gif.py — ฉากไลน์ชุบ (ตรงผัง CHEM1: LOAD → DEGREASE×2 → PLATE×2 → UNLOAD)
#   รางบน + รถยก 2 คันวิ่งไปมา · บ่อน้ำยาผิวกระเพื่อม · ฟองในบ่อ PLATE · ป้ายบ่อ
#   เป็น "ฉากหลัง" — ตัวเลข carrier จริงมาจาก widget ที่วางทับ (tag lr_pos1-6 จาก feeder)
import math, os
from PIL import Image, ImageDraw, ImageFont
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _scaled import ScaledDraw, scaled_image, scaled_font
S = 1.5                     # 1200 logical → 1800 จริง (canvas Full HD 1920 กว้าง) — วาด native ไม่ยืดภาพ


W, H = 1200, 260
FRAMES = 48
BG      = (10, 14, 26)
CARD    = (17, 24, 39)
LINE    = (31, 41, 55)
STEEL   = (59, 75, 102)
GREEN   = (52, 211, 153)
GREEN_D = (34, 150, 110)
BLUE    = (96, 165, 250)
BLUE_D  = (43, 84, 150)
GRAY    = (156, 163, 175)

FONT = scaled_font(15, S)

# 6 บ่อ ตรงกับ positions ของ CHEM1 (pos1..6)
TANKS = [('LOAD', None), ('DEGREASE 1', BLUE_D), ('DEGREASE 2', BLUE_D),
         ('PLATE 1', GREEN_D), ('PLATE 2', GREEN_D), ('UNLOAD', None)]
TW, GAP, X0 = 168, 24, 40
TY0, TY1 = 118, 226

frames = []
for f in range(FRAMES):
    ph = f / FRAMES
    im = scaled_image(W, H, S, BG)
    d = ScaledDraw(im, S)

    # รางเครน + เสา
    d.rectangle([20, 28, W-20, 34], fill=STEEL)
    for px in (30, W-36):
        d.rectangle([px, 34, px+8, TY0-6], fill=CARD, outline=STEEL)

    # บ่อ
    for i, (name, liquid) in enumerate(TANKS):
        x0 = X0 + i*(TW+GAP); x1 = x0 + TW
        d.rounded_rectangle([x0, TY0, x1, TY1], 8, fill=CARD, outline=STEEL, width=2)
        if liquid:
            surf = TY0 + 26 + 3*math.sin(ph*2*math.pi + i)
            d.rounded_rectangle([x0+4, surf, x1-4, TY1-4], 6, fill=liquid)
            d.line([x0+6, surf, x1-6, surf], fill=(liquid[0]+40, liquid[1]+40, min(255, liquid[2]+60)), width=2)
            if name.startswith('PLATE'):
                for bi in range(3):                     # ฟองในบ่อชุบ
                    bp = (ph + bi/3 + i*0.17) % 1.0
                    by = TY1 - 10 - bp*(TY1 - surf - 18)
                    bx = x0 + 30 + bi*46 + 5*math.sin(bp*6)
                    d.ellipse([bx-3, by-3, bx+3, by+3], outline=GREEN, width=1)
                d.rectangle([x0+14, surf-8, x0+20, TY1-14], fill=STEEL)   # แท่ง anode
                d.rectangle([x1-20, surf-8, x1-14, TY1-14], fill=STEEL)
        else:
            d.rectangle([x0+10, TY1-16, x1-10, TY1-8], fill=LINE)          # แท่นวาง
        tw = d.textlength(name, font=FONT)
        d.text((x0 + (TW-tw)/2, TY1 + 8), name, font=FONT, fill=GRAY)

    # รถยก 2 คันวิ่งไปมาบนราง (คนละเฟส) + ตะขอ + คานแขวนงาน
    for hi in range(2):
        hp = 0.5 - 0.5*math.cos((ph + hi*0.5) % 1.0 * 2*math.pi)      # ease กลับไปกลับมา
        hx = 80 + hp * (W - 220)
        d.rounded_rectangle([hx, 18, hx+64, 40], 4, fill=CARD, outline=STEEL, width=2)
        d.ellipse([hx+8, 36, hx+20, 48], outline=STEEL, width=2)
        d.ellipse([hx+44, 36, hx+56, 48], outline=STEEL, width=2)
        drop = 26 + 10*math.sin((ph*2 + hi) * 2*math.pi)              # ตะขอโยกขึ้นลง
        d.line([hx+32, 40, hx+32, 40+drop], fill=STEEL, width=3)
        d.rectangle([hx+12, 40+drop, hx+52, 46+drop], fill=STEEL)      # คานแขวน
        for wx in (hx+16, hx+32, hx+48):
            d.line([wx, 46+drop, wx, 58+drop], fill=GREEN, width=2)    # ชิ้นงานห้อย

    frames.append(im.quantize(colors=64, dither=Image.Dither.NONE))

out = os.path.join(os.path.dirname(__file__), '..', 'seed', 'chemline.gif')
frames[0].save(out, save_all=True, append_images=frames[1:], duration=90, loop=0, disposal=2, optimize=True)
print(f'เขียน {os.path.abspath(out)} · {os.path.getsize(out)//1024} KB')
