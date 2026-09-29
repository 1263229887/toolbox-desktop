#!/usr/bin/env node
/**
 * 定 MI-GAN pipeline 的 mask 约定：把三种可能的编码各跑一遍，
 * 用「水印带内与手工成品的 PSNR」判定哪一种真的在修复。
 */
import fs from 'node:fs'
import * as ort from 'onnxruntime-web'

const meta = JSON.parse(fs.readFileSync('/tmp/wmsp/meta.json', 'utf8'))
const { w, h } = meta
const [x0, y0, x1, y1] = meta.bbox
const px = w * h
const image = fs.readFileSync('/tmp/wmsp/image.rgb')
const maskRaw = fs.readFileSync('/tmp/wmsp/mask.bin')
const ref = fs.readFileSync('/tmp/wmsp/ref.rgb')

const session = await ort.InferenceSession.create('/tmp/wmsp/migan_pipeline_v2.onnx', { graphOptimizationLevel: 'all', logSeverityLevel: 3 })

function chw(src, fn) {
  const out = new Uint8Array(px * 3)
  for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) out[c * px + i] = fn(src[i * 3 + c])
  return out
}

function psnrInBand(rgb) {
  let se = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3
      for (let c = 0; c < 3; c++) {
        const d = rgb[i + c] - ref[i + c]
        se += d * d
        n++
      }
    }
  }
  const mse = se / n
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse)
}

const imgCHW = chw(image, (v) => v)
const variants = {
  '非零=洞 (255)': (i) => (maskRaw[i] ? 255 : 0),
  '非零=保留 (反转)': (i) => (maskRaw[i] ? 0 : 255),
  '反转且二值1': (i) => (maskRaw[i] ? 0 : 1),
}

console.log(`原图基线 PSNR（vs 手工成品）: ${psnrInBand(new Uint8Array(image)).toFixed(2)} dB`)
for (const [label, fn] of Object.entries(variants)) {
  const m = new Uint8Array(px)
  for (let i = 0; i < px; i++) m[i] = fn(i)
  const t0 = Date.now()
  const out = await session.run({
    image: new ort.Tensor('uint8', imgCHW, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', m, [1, 1, h, w]),
  })
  const r = out.result.data
  const rgb = new Uint8Array(px * 3)
  for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) rgb[i * 3 + c] = r[c * px + i]
  // 只在 mask 带内取模型输出，其余保留原图
  const comp = Uint8Array.from(image)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 3
    for (let c = 0; c < 3; c++) comp[i + c] = rgb[i + c]
  }
  console.log(`${label.padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s  PSNR ${psnrInBand(comp).toFixed(2)} dB`)
  if (label === '非零=保留 (反转)') fs.writeFileSync('/tmp/wmsp/best.rgb', Buffer.from(comp))
}
