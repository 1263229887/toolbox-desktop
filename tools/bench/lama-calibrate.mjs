#!/usr/bin/env node
/**
 * LaMa(ONNX) 用法标定：上次我跑出墨绿涂抹，怀疑是归一化区间或 mask 语义搞错。
 * 把 4 种组合穷举一遍，用「水印带与手工成品的 PSNR」定死正确用法，
 * 顺便和 MI-GAN 在同一样张、同一 mask 上比高低。
 */
import fs from 'node:fs'
import * as ort from 'onnxruntime-web'

ort.env.wasm.wasmPaths = '/tmp/ortmin/'
ort.env.wasm.numThreads = 4

const crop = JSON.parse(fs.readFileSync('/tmp/lama/crop.json', 'utf8'))
const meta = JSON.parse(fs.readFileSync('/tmp/wmsp/meta.json', 'utf8'))
const S = 512
const img = fs.readFileSync('/tmp/lama/img.rgb')
const msk = fs.readFileSync('/tmp/lama/mask.bin')
// 参考值：他手工成品在同一裁剪框内的像素
const ref = fs.readFileSync('/tmp/lama/ref512.rgb')

const px = S * S
function toChw(src, conv) {
  const out = new Float32Array(px * 3)
  for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) out[c * px + i] = conv(src[i * 3 + c])
  return out
}
const maskArr = (holeValue) => {
  const out = new Float32Array(px)
  for (let i = 0; i < px; i++) out[i] = (msk[i] > 127) === (holeValue === 1) ? holeValue : 1 - holeValue
  return out
}
function psnr(a) {
  let se = 0
  let n = 0
  for (let i = 0; i < px * 3; i++) {
    const d = a[i] - ref[i]
    se += d * d
    n++
  }
  const mse = se / n
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse)
}

const session = await ort.InferenceSession.create('/tmp/wmsp/lama_fp32.onnx', { logSeverityLevel: 3 })
const outName = session.outputNames[0]
const base = psnr(img)
console.log(`裁剪框 ${crop.box}  原图 vs 手工成品 PSNR ${base.toFixed(2)} dB（基线）`)

let best = { psnr: -1 }
for (const norm of ['minus1', 'zero1']) {
  for (const hole of [1, 0]) {
    const conv = norm === 'minus1' ? (v) => (v - 127.5) / 127.5 : (v) => v / 255
    const feeds = {
      image: new ort.Tensor('float32', toChw(img, conv), [1, 3, S, S]),
      mask: new ort.Tensor('float32', maskArr(hole), [1, 1, S, S]),
    }
    const r = await session.run(feeds)
    const o = r[outName].data
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < o.length; i += 331) { if (o[i] < lo) lo = o[i]; if (o[i] > hi) hi = o[i] }
    const denorm = hi <= 1.05 ? (v) => v * 255 : (v) => v
    const rgb = new Uint8Array(px * 3)
    for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(denorm(o[c * px + i]))))
    const p = psnr(rgb)
    console.log(`norm=${norm.padEnd(7)} mask洞=${hole}  输出值域[${lo.toFixed(2)},${hi.toFixed(2)}]  PSNR ${p.toFixed(2)} dB`)
    if (p > best.psnr) best = { psnr: p, rgb, norm, hole }
  }
}
fs.writeFileSync('/tmp/lama/best512.rgb', Buffer.from(best.rgb))
// 膨胀实验：同一张图，mask 分别不膨胀 / 膨胀 6px / 12px，看 PSNR 走向
const dil = async (radius) => {
  const m = new Float32Array(px)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let hit = 0
    for (let dy = -radius; dy <= radius && !hit; dy++) for (let dx = -radius; dx <= radius && !hit; dx++) {
      const ny = y + dy
      const nx = x + dx
      if (ny >= 0 && nx >= 0 && ny < S && nx < S && msk[ny * S + nx] > 127) hit = 1
    }
    m[y * S + x] = hit
  }
  const r = await session.run({
    image: new ort.Tensor('float32', toChw(img, (v) => v / 255), [1, 3, S, S]),
    mask: new ort.Tensor('float32', m, [1, 1, S, S]),
  })
  const o = r[outName].data
  const rgb = new Uint8Array(px * 3)
  // 该导出输出已是 0-255，不能再乘 255
  for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(o[c * px + i])))
  return { rgb, p: psnr(rgb) }
}
for (const radius of [0, 6, 12]) {
  const { rgb, p } = await dil(radius)
  fs.writeFileSync(`/tmp/lama/dil${radius}.rgb`, Buffer.from(rgb))
  console.log(`mask 膨胀 ${radius}px → PSNR ${p.toFixed(2)} dB`)
}
console.log(`\n最佳组合：norm=${best.norm} mask洞=${best.hole}  PSNR ${best.psnr.toFixed(2)} dB`)
console.log('→ /tmp/lama/best512.rgb（供 python 出对比图）')
