#!/usr/bin/env python3
# gen-logo.py — โลโก้ demo (มาร์ค "K" ทรงเพชร + สายฟ้า บนพื้นไล่เฉด — โทนเดียวกับ dashboard)
#   ธีม: หกเหลี่ยม/เพชร = โครง PLC/เซนเซอร์ · สายฟ้าตัดกลาง = "live/real-time" ตรงกับจุดขายของระบบ
#   วาด supersample 4x แล้วย่อ (anti-alias คมชัดไม่ต้องพึ่ง lib เสริม) → PNG โปร่งใส 512x512
import math, base64, json, os
from PIL import Image, ImageDraw

S = 512
SS = 4                                  # supersample factor
W = S * SS

GREEN = (52, 211, 153, 255)
GREEN2 = (16, 185, 129, 255)
BLUE = (96, 165, 250, 255)
BLUE_D = (30, 64, 145, 255)
DEEP = (10, 14, 26, 255)

im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
cx = cy = W / 2

# พื้นหลังเพชร (rounded diamond) ไล่เฉดฟ้าเข้ม→น้ำเงินเข้ม แนวทแยง
bg = Image.new('RGBA', (W, W), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
R = W * 0.46
pts = [(cx, cy - R), (cx + R, cy), (cx, cy + R), (cx - R, cy)]
# soften corners: แทรกจุดโค้งมนที่มุมด้วย quad bezier แบบง่าย (ประมาณด้วย polygon หลายจุด)
def rounded_diamond(r, k=0.22):
    P = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    out = []
    n = len(P)
    for i in range(n):
        a, b, c = P[(i - 1) % n], P[i], P[(i + 1) % n]
        # จุดเข้า-ออกใกล้มุม b เพื่อมนมุม
        in_pt = (b[0] + (a[0] - b[0]) * k, b[1] + (a[1] - b[1]) * k)
        out_pt = (b[0] + (c[0] - b[0]) * k, b[1] + (c[1] - b[1]) * k)
        out.append(in_pt)
        # เส้นโค้งมุมด้วยจุดกลางหลายจุด (ประมาณ arc)
        for t in range(1, 6):
            tt = t / 6
            mx = in_pt[0] + (b[0] - in_pt[0]) * tt
            my = in_pt[1] + (b[1] - in_pt[1]) * tt
            mx2 = b[0] + (out_pt[0] - b[0]) * tt
            my2 = b[1] + (out_pt[1] - b[1]) * tt
            out.append((mx + (mx2 - mx) * tt, my + (my2 - my) * tt))
        out.append(out_pt)
    return out

diamond = rounded_diamond(R)
for y in range(0, W, 2):
    tpix = max(0.0, min(1.0, (y / W)))
    col = tuple(int(BLUE_D[i] + (GREEN2[i] - BLUE_D[i]) * tpix) for i in range(3)) + (255,)
    bd.line([(0, y), (W, y)], fill=col, width=2)
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).polygon(diamond, fill=255)
im.paste(bg, (0, 0), mask)

# ขอบสว่างบาง ๆ
ImageDraw.Draw(im).line(diamond + [diamond[0]], fill=(255, 255, 255, 60), width=int(3 * SS / 2))

# แผงวงจร/โหนดจุดเชื่อม (มุมเพชร) — ให้ความรู้สึก "sensor network"
for (px, py) in [(cx, cy - R * 0.62), (cx + R * 0.62, cy), (cx, cy + R * 0.62), (cx - R * 0.62, cy)]:
    ImageDraw.Draw(im).ellipse([px - 7 * SS, py - 7 * SS, px + 7 * SS, py + 7 * SS], fill=(255, 255, 255, 70))

# ตัว K เรขาคณิต ชัดเจน — แท่งตั้งซ้าย + 2 แขนทแยงชนกลาง (จุดหักเบี่ยงเล็กน้อย = ลายเซ็น "สายฟ้า/live")
barW = W * 0.075
x0 = cx - W * 0.155
WHITE = (245, 250, 255, 255)
d.rounded_rectangle([x0, cy - W*0.205, x0 + barW, cy + W*0.205], barW * 0.32, fill=WHITE)

apex_x, apex_y = x0 + barW - W*0.012, cy               # จุดชนแท่งตั้ง (กึ่งกลางแนวตั้ง)
tip_x = x0 + barW + W*0.235                            # ปลายแขนทั้งสอง (ขวาสุด)

def diag_arm(y_tip, bend_frac=0.42, bend_off=0.026, thick=0.058):
    # แขนทแยงจาก apex → tip โดยมีจุดหักกลางทาง (bend) เยื้องเล็กน้อยให้ดูเป็นสายฟ้า ไม่ใช่เส้นตรงทื่อ ๆ
    bx = apex_x + (tip_x - apex_x) * bend_frac
    by = apex_y + (y_tip - apex_y) * bend_frac + W*bend_off
    dx, dy = tip_x - apex_x, y_tip - apex_y
    L = math.hypot(dx, dy); nx, ny = -dy / L, dx / L      # เส้นตั้งฉากไว้ทำความหนา
    t = W * thick
    return [
        (apex_x, apex_y),
        (bx + nx*t*0.5, by + ny*t*0.5),
        (tip_x + nx*t*0.4, y_tip + ny*t*0.4),
        (tip_x - nx*t*0.4, y_tip - ny*t*0.4),
        (bx - nx*t*0.5, by - ny*t*0.5),
    ]

arm_up = diag_arm(cy - W*0.205)
arm_dn = diag_arm(cy + W*0.205)
d.polygon(arm_up, fill=GREEN)
d.polygon(arm_dn, fill=GREEN)
for arm in (arm_up, arm_dn):
    ImageDraw.Draw(im).line(arm + [arm[0]], fill=(255,255,255,90), width=int(SS*1.1), joint='curve')
# จุดสว่างตรงรอยต่อ apex — เน้นความรู้สึก "จุดเชื่อมสัญญาณ"
ImageDraw.Draw(im).ellipse([apex_x-9*SS, apex_y-9*SS, apex_x+9*SS, apex_y+9*SS], fill=(255,255,255,220))

logo = im.resize((S, S), Image.LANCZOS)

out_dir = os.path.join(os.path.dirname(__file__), '..', 'seed')
png_path = os.path.join(out_dir, 'logo.png')
logo.save(png_path)

# data-url สำหรับ seed branding.json (ต้องเป็น string เดียวไม่มีบรรทัดใหม่)
with open(png_path, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()
dataurl = 'data:image/png;base64,' + b64
open(os.path.join(out_dir, 'branding.json'), 'w', encoding='utf-8').write(
    json.dumps({"appName": "KPE SCADA", "logo": dataurl, "logoFit": "contain"}, ensure_ascii=False, indent=2))

print(f'เขียน {png_path} ({os.path.getsize(png_path)//1024} KB) + seed/branding.json (data-url {len(dataurl)//1024} KB)')
