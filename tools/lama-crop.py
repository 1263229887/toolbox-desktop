#!/usr/bin/env python3
"""按 LaMa 的用法准备 512x512 输入：以水印框为中心取方形区域、缩放到 512。
   输出 crop.json 记录还原所需的偏移与缩放。"""
import json
from PIL import Image

S = 512
meta = json.load(open('/tmp/wmsp/meta.json'))
w, h = meta['w'], meta['h']
x0, y0, x1, y1 = meta['bbox']
src = Image.open('/tmp/wmsp/src.png').convert('RGB')
mask = Image.open('/tmp/wmsp/mask.png').convert('L')

bw, bh = x1 - x0, y1 - y0
import sys
PAD = float(sys.argv[1]) if len(sys.argv) > 1 else 2.5
side = int(min(max(bw, bh) * PAD, min(w, h)))
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
l = max(0, min(cx - side // 2, w - side))
t = max(0, min(cy - side // 2, h - side))
box = (l, t, l + side, t + side)

crop_img = src.crop(box).resize((S, S), Image.BILINEAR)
crop_mask = mask.crop(box).resize((S, S), Image.BILINEAR)
crop_img.save('/tmp/lama/img.png')
crop_mask.save('/tmp/lama/mask.png')
# node 侧没有图片解码器，直接给 raw 字节
open('/tmp/lama/img.rgb','wb').write(crop_img.tobytes())
open('/tmp/lama/mask.bin','wb').write(crop_mask.tobytes())
json.dump({'box': list(box), 'side': side, 'w': w, 'h': h}, open('/tmp/lama/crop.json', 'w'))
print(f'LaMa 输入 {S}x{S}，取原图区域 {box}（水印框 {meta["bbox"]}，放大系数 {PAD}）')
