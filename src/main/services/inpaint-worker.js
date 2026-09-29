/**
 * 推理 worker：跑在 utilityProcess 里，不在主进程、也不在渲染进程。
 *   - 不放主进程：ONNX Runtime 原生/WASM 崩溃会带走整个应用；
 *   - 不放渲染进程：ort-web 1.30 只提供 threaded wasm，需要 SharedArrayBuffer，
 *     而打包后的页面是 file:// origin，拿不到 crossOriginIsolated。
 * ort-web 与模型都来自按需下载的模型包目录，安装包里一个字节都不带。
 *
 * 通信用 Electron 的 process.parentPort（utilityProcess 语义），不是 worker_threads 的 parentPort。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let ort = null
let inpaintSession = null
let detectSession = null

async function init(modelDir) {
  // Windows 上 modelDir 是 C:\...，直接当 URL 会被 ESM loader 认成 scheme `c:`。
  // import / wasmPaths 必须走 pathToFileURL；onnx 用字节传入，避开同一坑。
  const ortDir = path.join(modelDir, 'ort')
  const ortUrl = pathToFileURL(path.join(ortDir, 'ort.node.min.mjs')).href
  ort = await import(ortUrl)
  ort.env.wasm.wasmPaths = pathToFileURL(ortDir).href + '/'
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4)))
  const inpaint = new Uint8Array(fs.readFileSync(path.join(modelDir, 'migan_pipeline_v2.onnx')))
  const detect = new Uint8Array(fs.readFileSync(path.join(modelDir, 'ch_PP-OCRv4_det_mobile.onnx')))
  inpaintSession = await ort.InferenceSession.create(inpaint, { graphOptimizationLevel: 'all', logSeverityLevel: 3 })
  detectSession = await ort.InferenceSession.create(detect, { graphOptimizationLevel: 'all', logSeverityLevel: 3 })
  return { threads: ort.env.wasm.numThreads }
}

/* ---------------- 文字/角标检测（DBNet 概率图 → 候选框） ---------------- */

function preprocessDet(image, w, h, limit = 960) {
  const scale = Math.min(1, limit / Math.max(w, h))
  const nw = Math.max(32, Math.round((w * scale) / 32) * 32)
  const nh = Math.max(32, Math.round((h * scale) / 32) * 32)
  const out = new Float32Array(nw * nh * 3)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh))
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw))
      const i = (sy * w + sx) * 3
      const o = y * nw + x
      for (let c = 0; c < 3; c++) out[c * nw * nh + o] = (image[i + c] / 255 - mean[c]) / std[c]
    }
  }
  return { tensor: new ort.Tensor('float32', out, [1, 3, nh, nw]), nw, nh }
}

/** 概率图上的连通块外接框。不做轮廓+unclip：去水印宁可多盖一圈，也别留残影。 */
function boxesFromProb(prob, nw, nh, threshold = 0.35) {
  const seen = new Uint8Array(nw * nh)
  const boxes = []
  const stack = new Int32Array(nw * nh)
  for (let i = 0; i < nw * nh; i++) {
    if (seen[i] || prob[i] < threshold) continue
    let head = 0
    let n = 0
    let x0 = nw
    let y0 = nh
    let x1 = 0
    let y1 = 0
    stack[head++] = i
    seen[i] = 1
    while (n < head) {
      const p = stack[n++]
      const px = p % nw
      const py = (p / nw) | 0
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (const q of [p - 1, p + 1, p - nw, p + nw]) {
        if (q < 0 || q >= nw * nh || seen[q] || prob[q] < threshold) continue
        const qx = q % nw
        if (q === p - 1 && qx === nw - 1) continue
        if (q === p + 1 && qx === 0) continue
        seen[q] = 1
        stack[head++] = q
      }
    }
    boxes.push({ x0, y0, x1, y1, area: (x1 - x0 + 1) * (y1 - y0 + 1) })
  }
  return boxes
}

function luma(image, w, h, x, y) {
  const i = (y * w + x) * 3
  return 0.299 * image[i] + 0.587 * image[i + 1] + 0.114 * image[i + 2]
}

/**
 * 判定「这串文字像不像叠加水印」：
 * 半透明水印的本质是往局部推一层亮色，所以框内亮度要明显高于框外一圈；
 * 另外它通常贴在边缘、且相对画面很扁。三条都不满足的（正文、字幕居中）不预选。
 */
function scoreCandidate(image, w, h, b) {
  const bw = b.x1 - b.x0 + 1
  const bh = b.y1 - b.y0 + 1
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  if (bh > h * 0.14) return 0
  const edgeDist = Math.min(cx, w - cx, cy, h - cy) / Math.max(w, h)
  const nearEdge = edgeDist < 0.34
  let inside = 0
  let count = 0
  for (let y = b.y0; y <= b.y1; y += 2) for (let x = b.x0; x <= b.x1; x += 2) {
    inside += luma(image, w, h, x, y)
    count++
  }
  const pad = Math.max(6, bh)
  let ring = 0
  let rc = 0
  for (let y = Math.max(0, b.y0 - pad); y < Math.min(h, b.y1 + pad + 1); y += 3) {
    for (let x = Math.max(0, b.x0 - pad); x < Math.min(w, b.x1 + pad + 1); x += 3) {
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) continue
      ring += luma(image, w, h, x, y)
      rc++
    }
  }
  const lift = rc ? inside / count - ring / rc : 0
  if (lift < 6) return 0
  return (nearEdge ? 0.5 : 0.15) + Math.min(0.35, lift / 60) + Math.min(0.2, bw / w)
}

async function detect({ image, w, h }) {
  const { tensor, nw, nh } = preprocessDet(image, w, h)
  const out = await detectSession.run({ x: tensor })
  const key = detectSession.outputNames[0]
  const prob = out[key].data
  const sx = w / nw
  const sy = h / nh
  const raw = boxesFromProb(prob, nw, nh)
  const boxes = []
  for (const b of raw) {
    if (b.area < 10) continue
    const full = { x0: Math.max(0, Math.floor(b.x0 * sx)), y0: Math.max(0, Math.floor(b.y0 * sy)), x1: Math.min(w - 1, Math.ceil(b.x1 * sx)), y1: Math.min(h - 1, Math.ceil(b.y1 * sy)) }
    const score = scoreCandidate(image, w, h, full)
    if (score <= 0) continue
    boxes.push({ ...full, score: Number(Math.min(1, score).toFixed(3)) })
  }
  // 同一行的碎片（逐字检测出来的）合并成一条，避免漏字
  return mergeRows(boxes).sort((a, b) => b.score - a.score).slice(0, 12)
}

function mergeRows(boxes) {
  const out = []
  const used = new Array(boxes.length).fill(false)
  for (let i = 0; i < boxes.length; i++) {
    if (used[i]) continue
    let a = { ...boxes[i] }
    used[i] = true
    let changed = true
    while (changed) {
      changed = false
      for (let j = 0; j < boxes.length; j++) {
        if (used[j]) continue
        const b = boxes[j]
        const vOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
        const hOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
        const minH = Math.min(a.y1 - a.y0, b.y1 - b.y0)
        const gap = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2)
        if ((vOverlap > minH * 0.5 && gap < Math.max(a.x1 - a.x0, b.x1 - b.x0) * 2) || hOverlap > 0 && vOverlap > minH * 0.5) {
          a = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), score: Math.max(a.score, b.score) }
          used[j] = true
          changed = true
        }
      }
    }
    out.push(a)
  }
  return out
}

/* ---------------- 修复 ---------------- */

async function inpaint({ image, mask, w, h }) {
  const px = w * h
  const img = new Uint8Array(px * 3)
  for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) img[c * px + i] = image[i * 3 + c]
  const msk = new Uint8Array(px)
  // MI-GAN pipeline 的约定与 lama-cleaner 相反：非零=保留，零=待修复（实测 PSNR 24.4 vs 20.0）
  for (let i = 0; i < px; i++) msk[i] = mask[i] ? 0 : 255
  const out = await inpaintSession.run({
    image: new ort.Tensor('uint8', img, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', msk, [1, 1, h, w]),
  })
  const r = out[inpaintSession.outputNames[0]].data
  const rgb = new Uint8Array(px * 3)
  for (let c = 0; c < 3; c++) for (let i = 0; i < px; i++) rgb[i * 3 + c] = r[c * px + i]
  return { image: rgb, w, h }
}

process.parentPort.on('message', async (msg) => {
  try {
    const { id, type, payload } = msg.data ?? msg
    let result
    if (type === 'init') result = await init(payload.modelDir)
    else if (type === 'detect') result = await detect(payload)
    else if (type === 'inpaint') result = await inpaint(payload)
    else throw new Error(`未知请求 ${type}`)
    process.parentPort.postMessage({ id, ok: true, result })
  } catch (e) {
    process.parentPort.postMessage({ id: msg?.data?.id ?? msg?.id, ok: false, error: e.message })
  }
})
