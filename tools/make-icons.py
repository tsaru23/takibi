# 焚火のアイコンをコードで描いて PNG に書き出す（python tools/make-icons.py）。要 Pillow。
# 背景は端まで塗りつぶし、炎は中央の 60% に収めてある（maskable にしても切れない）。
import math, os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icons')
S = 1024  # 描画は大きく描いて縮小する

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def bezier(p0, p1, p2, p3, n=40):
    pts = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        pts.append((u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                    u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]))
    return pts

def flame(cx, base_y, h, w):
    # 左の輪郭 → 先端 → 右の輪郭
    top = (cx + w * 0.05, base_y - h)
    left = bezier((cx, base_y), (cx - w * 0.75, base_y - h * 0.12), (cx - w * 0.45, base_y - h * 0.55), top)
    right = bezier(top, (cx + w * 0.6, base_y - h * 0.5), (cx + w * 0.8, base_y - h * 0.1), (cx, base_y))
    return left + right[1:]

def make():
    im = Image.new('RGB', (S, S))
    d = ImageDraw.Draw(im)
    for y in range(S):  # 夜の背景: 上が暗く、下が少し暖かい
        d.line([(0, y), (S, y)], fill=lerp((10, 6, 4), (44, 20, 10), (y / S) ** 1.6))
    glow = Image.new('RGB', (S, S), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([S*0.2, S*0.3, S*0.8, S*0.95], fill=(120, 50, 10))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.1))
    im = Image.blend(im, Image.composite(glow, im, Image.new('L', (S, S), 255)), 0.0)
    from PIL import ImageChops
    im = ImageChops.add(im, glow)
    d = ImageDraw.Draw(im)
    cx = S / 2
    # 薪（×字に交差した2本）
    log = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(log)
    for ang in (-18, 18):
        part = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        pd = ImageDraw.Draw(part)
        pd.rounded_rectangle([cx - S*0.27, S*0.745, cx + S*0.27, S*0.805], radius=S*0.03, fill=(86, 50, 28, 255))
        pd.rounded_rectangle([cx - S*0.27, S*0.745, cx + S*0.27, S*0.765], radius=S*0.02, fill=(120, 74, 42, 255))
        part = part.rotate(ang, center=(cx, S*0.775), resample=Image.BICUBIC)
        log = Image.alpha_composite(log, part)
    # 炎: 外（橙）→ 中（黄）→ 芯（白っぽい）
    fl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fl)
    fd.polygon(flame(cx, S*0.78, S*0.46, S*0.34), fill=(255, 112, 28, 255))
    fd.polygon(flame(cx + S*0.005, S*0.78, S*0.34, S*0.23), fill=(255, 176, 50, 255))
    fd.polygon(flame(cx + S*0.005, S*0.78, S*0.2, S*0.12), fill=(255, 232, 150, 255))
    base = im.convert('RGBA')
    base = Image.alpha_composite(base, fl)
    base = Image.alpha_composite(base, log)
    return base.convert('RGB')

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    big = make()
    for size, name in ((512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'apple-touch-icon.png')):
        big.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)
        print('wrote', name)
