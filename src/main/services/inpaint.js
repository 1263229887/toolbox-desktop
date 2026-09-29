import path from 'node:path'
import { app, utilityProcess } from 'electron'
import { ensure, modelDir, status as modelStatus } from './models.js'

// 主进程会被 rollup 切成 chunk，import.meta.url 的目录不稳定；worker 是独立产物，
// 只能按「应用根目录/out/main/worker/inpaint.js」定位（dev 是项目根，打包后是 app.asar）
const WORKER = path.join(app.getAppPath(), 'out/main/worker/inpaint.js')

/**
 * utilityProcess 生命周期：懒起、崩溃自动重启、空闲不额外占内存（推理进程随应用退出）。
 * 每次请求带自增 id，响应回来按 id 结算；worker 死了把所有挂起请求判失败，下次重建。
 */
let child = null
let seq = 0
const pending = new Map()

function spawn() {
  if (child) return child
  child = utilityProcess.fork(WORKER, [], { serviceName: '图像推理', stdio: 'pipe' })
  child.on('message', (msg) => {
    const job = pending.get(msg.id)
    if (!job) return
    pending.delete(msg.id)
    msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error))
  })
  child.on('exit', (code) => {
    child = null
    const error = new Error(`推理进程已退出（code ${code}），请重试`)
    for (const [, job] of pending) job.reject(error)
    pending.clear()
  })
  return child
}

function call(type, payload, timeout = 300000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`推理超时（${type}）`))
    }, timeout)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    spawn().postMessage({ id, type, payload })
  })
}

const ready = new Set()

async function ensureReady(id = 'migan') {
  if (!ready.has(id)) {
    await ensure(id)
    await call('init', { modelDir: modelDir(id) })
    ready.add(id)
  }
  return modelDir(id)
}

export async function wmStatus() {
  return modelStatus()
}

export async function wmPrepare(id, onProgress) {
  await ensure(id, onProgress)
  await call('init', { modelDir: modelDir(id) })
  ready.add(id)
  return { id, dir: modelDir(id) }
}

export async function wmDetect({ image, w, h }) {
  await ensureReady()
  return call('detect', { image, w, h }, 120000)
}

export async function wmInpaint({ image, mask, w, h }) {
  await ensureReady()
  return call('inpaint', { image, mask, w, h }, 600000)
}

export function wmShutdown() {
  child?.kill()
  child = null
  ready.clear()
}
