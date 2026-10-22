"""_scaled.py — วาดด้วยพิกัด "logical" เดิม แต่ออกภาพที่ความละเอียดสูงขึ้น (คมบนจอ Full HD)

ตัวสร้าง GIF ทั้งหมดเขียนพิกัดไว้ที่ระบบ 1200px กว้าง · พอ canvas ขยับเป็น 1920 ภาพเดิมจะถูก
ยืดขึ้น 1.5 เท่า = ขอบเบลอ · แทนที่จะไล่แก้ตัวเลขทุกบรรทัด (พังง่าย) ใช้ proxy ตัวนี้คูณพิกัด
ให้อัตโนมัติตอนวาด → ได้ภาพ native ที่ขนาดจริง ไม่มีการ upscale เลย

ใช้:
    from _scaled import ScaledDraw, scaled_image, scaled_font
    S = 1.5
    im = scaled_image(1200, 170, S)          # ได้ภาพจริง 1800x255
    d  = ScaledDraw(im, S)                    # d.rectangle([0,0,1200,170]) → วาดเต็มภาพ
    f  = scaled_font(14, S)
"""
from PIL import Image, ImageDraw, ImageFont

_FONT_PATH = '/System/Library/Fonts/Supplemental/Thonburi.ttc'


def scaled_image(w, h, s, bg=(0, 0, 0)):
    return Image.new('RGB', (int(round(w * s)), int(round(h * s))), bg)


def scaled_font(size, s):
    try:
        return ImageFont.truetype(_FONT_PATH, max(1, int(round(size * s))))
    except Exception:
        return ImageFont.load_default()


def _mul(v, s):
    """คูณพิกัดทุกตัวในโครงสร้าง (list/tuple ซ้อนกันได้) · ปล่อยค่าที่ไม่ใช่ตัวเลขไว้เหมือนเดิม"""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v * s
    if isinstance(v, (list, tuple)):
        return type(v)(_mul(x, s) for x in v)
    return v


class ScaledDraw:
    """ห่อ ImageDraw — คูณพิกัด/ความหนา/รัศมีด้วย s ให้อัตโนมัติ ก่อนส่งต่อของจริง"""

    # kwarg ที่เป็น "ระยะ" ต้องคูณด้วย (สีไม่ใช่ระยะ จึงไม่อยู่ในลิสต์)
    _LEN_KW = ('width', 'radius')

    def __init__(self, im, s):
        self._d = ImageDraw.Draw(im)
        self._s = s

    def _call(self, name, args, kwargs):
        s = self._s
        args = tuple(_mul(a, s) for a in args)
        kw = dict(kwargs)
        for k in self._LEN_KW:
            if k in kw and isinstance(kw[k], (int, float)):
                kw[k] = max(1, int(round(kw[k] * s)))
        return getattr(self._d, name)(*args, **kw)

    # เมธอดที่ generator ใช้จริง — ประกาศชัดดีกว่า __getattr__ (พลาดชื่อจะ error ทันที ไม่วาดผิดเงียบ ๆ)
    def rectangle(self, *a, **k):          return self._call('rectangle', a, k)
    def rounded_rectangle(self, *a, **k):  return self._call('rounded_rectangle', a, k)
    def ellipse(self, *a, **k):            return self._call('ellipse', a, k)
    def line(self, *a, **k):               return self._call('line', a, k)
    def polygon(self, *a, **k):            return self._call('polygon', a, k)
    def text(self, *a, **k):               return self._call('text', a, k)

    def textlength(self, text, font=None, **k):
        """คืนความยาวใน "หน่วย logical" — generator เอาไปคำนวณจัดกึ่งกลางต่อได้ตามเดิม"""
        return self._d.textlength(text, font=font, **k) / self._s
