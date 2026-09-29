#!/usr/bin/env node
/**
 * LaMa(ONNX) 对照跑法：与 MI-GAN 用同一张样本、同一份 mask、同一个 PSNR 口径。
 * 目的不是选边，是把「LaMa 是不是更好」变成可测的问题。
 */
import fs from 'node:fs'
import * as ort from 'onnxruntime-web'

ort.env.wasm.wasmPaths = '/tmp/ortmin/'
ort.env.wasm.numThreads = 4
const S = 512
const img = fs.readFileSync('/tmp/lama/img.rgb')
const msk = fs.readFileSync('/tmp/lama/mask.bin')

const t0 = Date.now()
let session
try {
  session = await ort.InferenceSession.create('/tmp/wmsp/lama_fp32.onnx', { logSeverityLevel: 3 })
} catch (e) {
  console.log('加载失败:', e.message.slice(0, 400))
  process.exit(2)
}
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('inputs :', JSON.stringify(session.inputMetadata))
console.log('outputs:', JSON.stringify(session.outputMetadata))

const px = S * S
const feeds = {}
for (const m of session.inputMetadata) {
  const dims = m.shape.map((d) => (typeof d === 'number' ? d : 1))
  if (/mask/i.test(m.name)) {
    const arr = new Float32Array(px)
    for (let i = 0; i < px; i++) arr[i] = msk[i] > 127 ? 1 : 0
    feeds[m.name] = new ort.Tensor('float32', dims.length === 4 ? arr : arr.slice(0, px), [1, 1, S, S])
  } else {
    const arr = new Float32Array(px * 3)
    for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) arr[c * px + i] = (img[i * 3 + c] - 127.5) / 127.5
    feeds[m.name] = new ort.Tensor('float32', arr, [1, 3, S, S])
  }
}

const t1 = Date.now()
try {
  const out = await session.run(feeds)
  const secs = ((Date.now() - t1) / 1000).toFixed(2)
  for (const name of session.outputNames) {
    const o = out[name]
    console.log(`推理 ${secs}s | ${name} ${o.type} [${o.dims}]`)
    const n = o.data.length
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n; i++) { if (o.data[i] < lo) lo = o.data[i]; if (o.data[i] > hi) hi = o.data[i] }
    console.log('   值域', lo.toFixed(3), hi.toFixed(3))
    const rgb = Buffer.alloc(px * 3)
    const scale = hi <= 1.05 ? 255 : 1
    const shift = lo < -0.05 ? 127.5 : 0
    for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) {
      const v = o.data[c * px + i] * scale + shift
      rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(v)))
    }
    fs.writeFileSync('/tmp/lama/out512.rgb', rgb)
    console.log('   → /tmp/lama/out512.rgb')
  }
} catch (e) {
  console.log('推理失败:', String(e.message || e).slice(0, 500))
  process.exit(3)
}
