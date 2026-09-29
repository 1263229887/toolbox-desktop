#!/usr/bin/env node
/**
 * MI-GAN ONNX 在 Node(WASM) 里的可行性 spike：node tools/wm-spike.mjs
 * 输入契约（实测 migan_pipeline_v2.onnx）：
 *   image uint8 [B,3,H,W] 0-255 / mask uint8 [B,1,H,W] 非零即修复区 / result uint8 [B,3,H,W]
 */
import fs from 'node:fs'
import * as ort from 'onnxruntime-web'

const meta = JSON.parse(fs.readFileSync('/tmp/wmsp/meta.json', 'utf8'))
const image = fs.readFileSync('/tmp/wmsp/image.rgb')
const mask = fs.readFileSync('/tmp/wmsp/mask.bin')
const { w, h, bbox } = meta
const px = w * h

const t0 = Date.now()
const session = await ort.InferenceSession.create(process.argv[2] || '/tmp/wmsp/migan_pipeline_v2.onnx', { graphOptimizationLevel: 'all', logSeverityLevel: 3 })
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(2)}s | 输入 ${w}x${h} 水印框 ${bbox} 占比 ${((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / px * 100).toFixed(2)}%`)

// HWC → CHW
const img = new Uint8Array(px * 3)
for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) img[c * px + i] = image[i * 3 + c]
const msk = new Uint8Array(px)
for (let i = 0; i < px; i++) msk[i] = mask[i] ? 255 : 0

const t1 = Date.now()
const out = await session.run({
  image: new ort.Tensor('uint8', img, [1, 3, h, w]),
  mask: new ort.Tensor('uint8', msk, [1, 1, h, w]),
})
const secs = (Date.now() - t1) / 1000
const r = out.result
let lo = 255
let hi = 0
for (let i = 0; i < r.data.length; i += 997) {
  if (r.data[i] < lo) lo = r.data[i]
  if (r.data[i] > hi) hi = r.data[i]
}
console.log(`推理 ${secs.toFixed(1)}s | 输出 ${r.type} [${r.dims}] 采样值域 ${lo}-${hi}`)

const rgb = Buffer.alloc(px * 3)
for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) rgb[i * 3 + c] = r.data[c * px + i]
fs.writeFileSync('/tmp/wmsp/out.rgb', rgb)
console.log('→ /tmp/wmsp/out.rgb')
