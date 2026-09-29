#!/usr/bin/env python3
"""把 spike 的 raw 输出合成回图片，并生成「原图 | MI-GAN | 他手工成品」三联放大对比 + 差异数字"""
import json
import math
import os
from PIL import Image

OUT = '/tmp/wmsp'
meta = json.load(open(f'{OUT}/meta.json'))
w, h = meta['w'], meta['h']
x0, y0, x1, y1 = meta['bbox']

src = Image.open(f'{OUT}/src.png').convert('RGB')
ref = Image.open(f'{OUT}/ref.png').convert('RGB')
gen = Image.frombytes('RGB', (w, h), open(f'{OUT}/out.rgb', 'rb').read())
mask = Image.open(f'{OUT}/mask.png').convert('L')

# 只在 mask 内取模型结果，其余保留原图：模型会顺手改动别处，全图替换会引入无关差异
comp = Image.composite(gen, src, mask)

pad = 8
cw = 380
ch = int((y1 - y0) * cw / (x1 - x0))
crops = [im.crop((x0, y0, x1, y1)).resize((cw, ch)) for im in (src, comp, ref)]
sheet = Image.new('RGB', (cw * 3 + pad * 4, ch + pad * 2), (244, 245, 247))
for i, c in enumerate(crops):
    sheet.paste(c, (pad + i * (cw + pad), pad))
sheet.save(f'{OUT}/compare.png')


def psnr(a, b, box):
    pa, pb = a.load(), b.load()
    se = 0
    n = 0
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            va, vb = pa[x, y], pb[x, y]
            se += sum((va[k] - vb[k]) ** 2 for k in range(3))
            n += 3
    mse = se / n
    return float('inf') if mse == 0 else 10 * math.log10(255 ** 2 / mse)


print(f'对比图 → {OUT}/compare.png   (左=原图 中=MI-GAN 右=你手工成品)')
print(f'水印带 PSNR  vs 你的手工成品：{psnr(comp, ref, (x0, y0, x1, y1)):.2f} dB')
print(f'                      原图基线：{psnr(src, ref, (x0, y0, x1, y1)):.2f} dB')
comp.save(f'{OUT}/result.png')
