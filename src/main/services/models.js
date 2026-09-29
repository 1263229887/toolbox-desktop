import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import extractZip from 'extract-zip'
import { downloadFile, UA } from './netio.js'
import { MODEL_PACKS } from './model-registry.js'
import { read as readSettings } from './settings.js'

/** 模型放宿主数据目录下，与插件包分开：插件只是 UI，特权计算留在宿主 */
export function modelsRoot() {
  return path.join(app.getPath('userData'), 'toolbox', 'models')
}

export function modelDir(id) {
  const dir = path.join(modelsRoot(), id)
  if (!dir.startsWith(modelsRoot() + path.sep)) throw new Error('非法模型 id')
  return dir
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

export async function status() {
  const out = []
  for (const pack of Object.values(MODEL_PACKS)) {
    const dir = modelDir(pack.id)
    const main = path.join(dir, pack.files.inpaint)
    const ready = fs.existsSync(main)
    let verified = false
    if (ready && pack.files.inpaintSha256) {
      verified = (await sha256Of(main)) === pack.files.inpaintSha256
    }
    out.push({ id: pack.id, name: pack.name, version: pack.version, summary: pack.summary, installed: ready, verified, dir, bytes: ready ? fs.statSync(main).size : 0 })
  }
  return out
}

/**
 * 下载 → 校验 zip 指纹 → 解压到临时目录 → 校验模型文件指纹 → 原子替换。
 * 两层校验都要：zip 指纹证明「拿到的是我发布的那个包」，模型指纹证明「包里的权重没被换过」。
 */
export async function ensure(id, onProgress) {
  const pack = MODEL_PACKS[id]
  if (!pack) throw new Error(`未知模型包：${id}`)
  const dir = modelDir(id)
  if (await exists(id)) return dir

  if (!pack.sha256) throw new Error('该模型包还没在发布时写入 SHA-256，拒绝下载未校验的模型')
  const cfg = await readSettings()
  // 换分发源时只换目录，指纹仍然按登记表校验：镜像/CDN 不能成为绕过校验的口子
  const url = cfg.modelBaseUrl ? `${cfg.modelBaseUrl.replace(/\/+$/, '')}/${pack.id}-${pack.version}.zip` : pack.url
  const tmp = await fsp.mkdtemp(path.join(app.getPath('temp'), `toolbox-model-${id}-`))
  const zipPath = path.join(tmp, 'pack.zip')
  const stage = path.join(tmp, 'stage')
  try {
    await downloadFile(url, zipPath, {
      headers: { 'User-Agent': UA.desktop },
      // 整段请求（含读 body）的上限。GitHub 直连一两百 KB/s，32MB 可能要十几分钟
      timeout: 7200000,
      retries: 10,
      totalHint: pack.size,
      onProgress: (p) => onProgress?.({ id, phase: 'downloading', received: p.received, total: pack.size || p.total }),
    })
    const digest = await sha256Of(zipPath)
    if (digest !== pack.sha256) throw new Error(`模型包 SHA-256 不匹配（期望 ${pack.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`)

    // Electron 的 fs 会拦截路径里含 node_modules 的操作（asar 支持），导致包内的
    // onnxruntime-common 解不出来。解压期间按官方开关关掉 asar 处理。
    process.noAsar = true
    try {
      await extractZip(zipPath, { dir: stage })
    } finally {
      process.noAsar = false
    }
    const model = path.join(stage, pack.files.inpaint)
    if (!fs.existsSync(model)) throw new Error(`包里缺少 ${pack.files.inpaint}`)
    if (pack.files.inpaintSha256) {
      const md = await sha256Of(model)
      if (md !== pack.files.inpaintSha256) throw new Error(`${pack.files.inpaint} 指纹不匹配（${md.slice(0, 12)}…）`)
    }

    await fsp.mkdir(path.dirname(dir), { recursive: true })
    const backup = `${dir}.prev`
    await fsp.rm(backup, { recursive: true, force: true })
    if (fs.existsSync(dir)) await fsp.rename(dir, backup)
    await fsp.rename(stage, dir)
    await fsp.rm(backup, { recursive: true, force: true })
    onProgress?.({ id, phase: 'done' })
    return dir
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
}

export async function exists(id) {
  const pack = MODEL_PACKS[id]
  return pack ? fs.existsSync(path.join(modelDir(id), pack.files.inpaint)) : false
}

export async function remove(id) {
  await fsp.rm(modelDir(id), { recursive: true, force: true })
  return true
}
