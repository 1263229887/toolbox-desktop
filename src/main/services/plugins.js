import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import extractZip from 'extract-zip'
import { request, downloadFile, UA } from './netio.js'
import { read as readSettings } from './settings.js'

export const PROTOCOL = 'toolbox-plugin'
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,40}$/

export function pluginRoot() {
  return path.join(app.getPath('userData'), 'toolbox', 'plugins')
}

/** 每个插件一个目录：<root>/<id>/manifest.json + <root>/<id>/dist/** */
export function pluginDir(id) {
  if (!ID_RE.test(id)) throw new Error(`非法插件 id：${id}`)
  return path.join(pluginRoot(), id)
}

/** 渲染进程用这个地址动态 import 插件入口；协议 handler 只做同一目录的只读映射 */
export function pluginEntryUrl(id, entry = 'dist/index.js') {
  return `${PROTOCOL}://${id}/${entry}`
}

function compareVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

/**
 * 把协议请求的路径限制在插件目录内。协议本身是 standard+secure，
 * 但 handler 收到 ../ 之类的路径仍会逃出目录，所以这里必须自己收敛。
 */
export function resolveWithin(id, rel) {
  const base = pluginDir(id)
  const target = path.resolve(base, '.' + path.sep + decodeURIComponent(String(rel || '').replace(/^\/+/, '')))
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('插件路径越界')
  return target
}

function readManifest(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  if (!ID_RE.test(raw.id)) throw new Error(`manifest.id 非法：${raw.id}`)
  return raw
}

export async function listInstalled() {
  const root = pluginRoot()
  await fsp.mkdir(root, { recursive: true })
  const names = await fsp.readdir(root)
  const out = []
  for (const name of names) {
    const dir = path.join(root, name)
    if (!fs.statSync(dir).isDirectory()) continue
    try {
      const manifest = readManifest(dir)
      const entryFile = path.join(dir, manifest.entry || 'dist/index.js')
      out.push({ ...manifest, installed: true, entryExists: fs.existsSync(entryFile), dir })
    } catch (e) {
      out.push({ id: name, name, installed: true, entryExists: false, broken: e.message })
    }
  }
  return out
}

export async function fetchRegistry() {
  const cfg = await readSettings()
  if (!cfg.pluginRegistryUrl) throw new Error('未配置插件清单地址')
  const res = await request(cfg.pluginRegistryUrl, { headers: { 'User-Agent': UA.desktop, Accept: 'application/json' }, timeout: 20000 })
  if (!res.ok) throw new Error(`清单获取失败 HTTP ${res.status}`)
  const data = res.json()
  const list = Array.isArray(data.plugins) ? data.plugins : []
  return { generatedAt: data.generatedAt || '', plugins: list }
}

/**
 * 下载 zip → 校验 SHA-256 → 解压到临时目录 → 整体改名。
 * 校验是必须的：清单里的 sha256 是我们自己发布的包指纹，镜像/CDN 换源后不能假设内容一致。
 */
export async function install(entry, onProgress) {
  if (!ID_RE.test(entry.id)) throw new Error(`非法插件 id：${entry.id}`)
  if (!entry.file) throw new Error('清单条目缺少 file 字段')
  const cfg = await readSettings()
  const url = /^https?:\/\//.test(entry.file) ? entry.file : new URL(entry.file, cfg.pluginRegistryUrl).toString()

  const root = pluginRoot()
  await fsp.mkdir(root, { recursive: true })
  const tmp = await fsp.mkdtemp(path.join(app.getPath('temp'), 'toolbox-plugin-'))
  const zipPath = path.join(tmp, `${entry.id}.zip`)
  const stageDir = path.join(tmp, 'stage')

  try {
    await downloadFile(url, zipPath, { onProgress: (p) => onProgress?.({ id: entry.id, phase: 'downloading', ...p }) })
    const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
    if (entry.sha256 && digest !== entry.sha256) throw new Error(`SHA-256 不匹配（期望 ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`)

    await fsp.rm(stageDir, { recursive: true, force: true })
    await extractZip(zipPath, { dir: stageDir })
    const manifest = readManifest(stageDir)
    if (manifest.id !== entry.id) throw new Error(`manifest.id（${manifest.id}）与清单条目（${entry.id}）不一致`)
    if (manifest.minHostVersion && compareVersion(app.getVersion(), manifest.minHostVersion) < 0) {
      throw new Error(`需要宿主版本 >= ${manifest.minHostVersion}，当前 ${app.getVersion()}`)
    }

    const target = pluginDir(entry.id)
    const backup = `${target}.prev`
    await fsp.rm(backup, { recursive: true, force: true })
    if (fs.existsSync(target)) await fsp.rename(target, backup)
    await fsp.rename(stageDir, target)
    await fsp.rm(backup, { recursive: true, force: true })
    return { ...manifest, installed: true, dir: target }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
}

export async function uninstall(id) {
  await fsp.rm(pluginDir(id), { recursive: true, force: true })
  return true
}
