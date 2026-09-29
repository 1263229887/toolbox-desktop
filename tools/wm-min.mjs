import fs from 'node:fs'
import * as ort from 'onnxruntime-web'
ort.env.wasm.wasmPaths = '/tmp/ortmin/'
ort.env.wasm.numThreads = 2
const meta = JSON.parse(fs.readFileSync('/tmp/wmsp/meta.json', 'utf8'))
const { w, h } = meta
const px = w * h
const image = fs.readFileSync('/tmp/wmsp/image.rgb')
const maskRaw = fs.readFileSync('/tmp/wmsp/mask.bin')
const img = new Uint8Array(px * 3)
for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) img[c * px + i] = image[i * 3 + c]
const m = new Uint8Array(px)
for (let i = 0; i < px; i++) m[i] = maskRaw[i] ? 0 : 255
const s = await ort.InferenceSession.create('/tmp/wmsp/migan_pipeline_v2.onnx', { logSeverityLevel: 3 })
const t0 = Date.now()
const out = await s.run({ image: new ort.Tensor('uint8', img, [1, 3, h, w]), mask: new ort.Tensor('uint8', m, [1, 1, h, w]) })
console.log('最小文件集推理 OK', ((Date.now() - t0) / 1000).toFixed(2) + 's', 'threads=' + ort.env.wasm.numThreads, '| 实际加载 wasm:', fs.readdirSync('/tmp/ortmin').join(','))
