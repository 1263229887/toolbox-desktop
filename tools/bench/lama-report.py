#!/usr/bin/env python3
"""把 LaMa 的 512 输出还原回原图，和 MI-GAN、手工成品放一起比，并给同一口径的 PSNR。"""
import json
import math
from PIL import Image

crop = json.load(open('/tmp/lama/crop.json'))
meta = json.load(open('/tmp/wmsp/meta.json'))
w, h = meta['w'], meta['h']
x0, y0, x1, y1 = meta['bbox']
l, t, r, b = crop['box']
side = crop['side']

src = Image.open('/tmp/wmsp/src.png').convert('RGB')
ref = Image.open('/tmp/wmsp/ref.png').convert('RGB')
mask = Image.open('/tmp/wmsp/mask.png').convert('L')

lama_full = src.copy()
lama = Image.frombytes('RGB', (512, 512), open('/tmp/lama/out512.rgb', 'rb').read()).resize((side, side), Image.BILINEAR)
lama_full.paste(lama, (l, t))
lama_comp = Image.composite(lama_full, src, mask)

migan_comp = Image.frombytes('RGB', (w, h), open('/tmp/wmsp/best.rgb', 'rb').read())


def psnr(a):
    pa, pb = a.load(), ref.load()
    se = n = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            va, vb = pa[x, y], pb[x, y]
            se += sum((va[k] - vb[k]) ** 2 for k in range(3))
            n += 3
    mse = se / n
    return float('inf') if mse == 0 else 10 * math.log10(255 ** 2 / mse)


cw = 300
ch = int((y1 - y0) * cw / (x1 - x0))
pad = 6
sheet = Image.new('RGB', (cw * 4 + pad * 5, ch + pad * 2 + 18), (244, 245, 247))
from PIL import ImageDraw
d = ImageDraw.Draw(sheet)
for i, (label, im) in enumerate([('原图', src), ('MI-GAN 28MB', migan_comp), ('LaMa 198MB', lama_comp), ('你手工成品', ref)]):
    d.text((pad + i * (cw + pad), 2), label, fill=(60, 66, 72))
    sheet.paste(im.crop((x0, y0, x1, y1)).resize((cw, ch)), (pad + i * (cw + pad), pad + 16))
sheet.save('/tmp/lama/versus.png')
print(f'水印带 PSNR（越高越接近你的手工成品）：原图基线 {psnr(src):.2f} dB')
print(f'  MI-GAN : {psnr(migan_comp):.2f} dB')
print(f'  LaMa   : {psnr(lama_comp):.2f} dB')
print('四联对比图 → /tmp/lama/versus.png')
