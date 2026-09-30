/**
 * 推理 worker：跑在 utilityProcess 里，不在主进程、也不在渲染进程。
 *   - 不放主进程：ONNX Runtime 原生/WASM 崩溃会带走整个应用；
 *   - 不放渲染进程：ort-web 1.30 只提供 threaded wasm，需要 SharedArrayBuffer，
 *     而打包后的页面是 file:// origin，拿不到 crossOriginIsolated。
 * ort-web 与模型都来自按需下载的模型包目录，安装包里一个字节都不带。
 *
 * 通信用 Electron 的 process.parentPort（utilityProcess 语义），不是 worker_threads 的 parentPort。
 */
import { createDetector } from './detect-core.js'

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

/* 检测逻辑在 detect-core.js：抽出去是为了能对真样本离线跑召回统计 */
const detect = createDetector({ getOrt: () => ort, getSession: () => detectSession })

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
    else if (type === 'detect') result = await detect({ image: payload.image, w: payload.w, h: payload.h })
    else if (type === 'inpaint') result = await inpaint(payload)
    else throw new Error(`未知请求 ${type}`)
    process.parentPort.postMessage({ id, ok: true, result })
  } catch (e) {
    process.parentPort.postMessage({ id: msg?.data?.id ?? msg?.id, ok: false, error: e.message })
  }
})
