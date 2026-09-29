#!/usr/bin/env python3
"""
从 ~/Pictures/{待,已}去水印 的配对图里：
  1) 差分得到真实水印 mask（两图不同处即水印）
  2) 导出 raw 像素给 node 侧推理用
  3) 推理完再合成并输出「原图 | 我们结果 | 他手工成品」三联对比图
"""
import json
import os
import sys
from PIL import Image, ImageFilter

SRC = os.path.expanduser('~/Pictures/待去水印')
REF = os.path.expanduser('~/Pictures/已去水印')
OUT = '/tmp/wmsp'
os.makedirs(OUT, exist_ok=True)

name = sys.argv[1] if len(sys.argv) > 1 else sorted(os.listdir(SRC))[0]
src = Image.open(os.path.join(SRC, name)).convert('RGB')
ref = Image.open(os.path.join(REF, name)).convert('RGB')
if ref.size != src.size:
    ref = ref.resize(src.size)
w, h = src.size

sp = src.load()
rp = ref.load()
mask = bytearray(w * h)
diff = Image.new('L', (w, h), 0)
dp = diff.load()
for y in range(h):
    for x in range(w):
        r1, g1, b1 = sp[x, y]
        r2, g2, b2 = rp[x, y]
        d = abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)
        dp[x, y] = 255 if d > 60 else 0

# 只保留水印所在的连通块区域的外接矩形，避免把压缩噪声也算进去
bbox = diff.getbbox()
if not bbox:
    print('两图无差异，换一张')
    sys.exit(1)
x0, y0, x1, y1 = bbox
print(f'样本 {name} 尺寸 {w}x{h} 差异外接框 {bbox}  占比 {((x1-x0)*(y1-y0))/(w*h)*100:.2f}%')

# mask 用真实差异像素再膨胀 3px，保证边缘残影也被覆盖
mask_img = diff.point(lambda v: 255 if v else 0)
for _ in range(3):
    mask_img = mask_img.filter(ImageFilter.MaxFilter(3))

with open(f'{OUT}/image.rgb', 'wb') as f:
    f.write(src.tobytes())
with open(f'{OUT}/mask.bin', 'wb') as f:
    f.write(mask_img.tobytes())
with open(f'{OUT}/meta.json', 'w') as f:
    json.dump({'name': name, 'w': w, 'h': h, 'bbox': list(bbox)}, f)
src.save(f'{OUT}/src.png')
ref.save(f'{OUT}/ref.png')
mask_img.save(f'{OUT}/mask.png')
print('导出 →', OUT)
