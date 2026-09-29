import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { parse as parseDouyin } from './services/douyin.js'
import { downloadFile, safeName, stamp, UA } from './services/netio.js'
import * as plugins from './services/plugins.js'
import { initUpdater } from './services/updater.js'
import { defaults, read as readSettings, write as writeSettings } from './services/settings.js'

const IMAGE_FILTERS = [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic'] }]
const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }]

/**
 * 渲染进程（以及按需下载的插件）能写的目录，仅限用户本次会话里亲手授权过的。
 * 没有这道闸，files:writeBatch 就等于把任意路径写入交给 Web 侧。
 */
const authorizedDirs = new Set()

function authorize(dir) {
  authorizedDirs.add(path.resolve(dir))
}

function guardWithinAuthorized(dir) {
  const target = path.resolve(String(dir || ''))
  const allowed = [...authorizedDirs].some((base) => target === base || target.startsWith(base + path.sep))
  if (!allowed) throw new Error(`目标目录未获授权：${target}`)
  return target
}

function ok(data) {
  return { ok: true, data }
}
function fail(e) {
  return { ok: false, error: (e && e.message) || String(e), stack: e && e.stack }
}

// 每个通道自己校验入参形状：preload 只按名字转发，边界检查放在这里才有意义
function wrap(handler) {
  return async (event, payload) => {
    try {
      return ok(await handler(event, payload || {}))
    } catch (e) {
      return fail(e)
    }
  }
}

export function registerIpc() {
  ipcMain.handle('app:info', wrap(async () => ({
    name: app.name,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    pluginRoot: plugins.pluginRoot(),
  })))

  ipcMain.handle('settings:get', wrap(async () => await readSettings()))
  ipcMain.handle('settings:reset', wrap(async () => await writeSettings(defaults())))
  ipcMain.handle('settings:set', wrap(async (_e, patch) => await writeSettings(patch)))

  ipcMain.handle('douyin:parse', wrap(async (_e, { text }) => await parseDouyin(text, await settingsForParse())))

  /**
   * 批量落地。图片和视频都走同一条流式下载，失败项不影响成功项，
   * 因为一张 15 图的图文里挂两张是常态，不能因为尾巴失败就把前面全丢掉。
   */
  ipcMain.handle('media:save', wrap(async (event, { items, folder, title }) => {
    const cfg = await readSettings()
    const dir = path.join(cfg.downloadDir, folder || 'douyin', stamp())
    await fsp.mkdir(dir, { recursive: true })
    const saved = []
    const failed = []
    const total = items.length
    let done = 0

    for (const [i, item] of items.entries()) {
      const base = item.type === 'video' ? safeName(title, `video-${i + 1}`) : String(i + 1).padStart(3, '0')
      const dest = path.join(dir, `${base}${item.ext || (item.type === 'video' ? '.mp4' : '.jpg')}`)
      try {
        const r = await downloadFile(item.url, dest, {
          headers: { 'User-Agent': UA.bot, Referer: 'https://www.douyin.com/' },
          onProgress: (p) => event.sender.send('media:progress', { phase: 'item', index: i, dest, ...p, done, total }),
        })
        saved.push({ name: path.basename(dest), size: r.size, type: item.type })
      } catch (e) {
        failed.push({ index: i, url: item.url, error: (e && e.message) || String(e) })
      }
      done++
      event.sender.send('media:progress', { phase: 'overall', done, total })
    }
    return { dir, saved, failed }
  }))

  ipcMain.handle('dialog:pickFiles', wrap(async (_e, { multiple = true, filters = IMAGE_FILTERS } = {}) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', ...(multiple ? ['multiSelections'] : [])], filters })
    if (r.canceled) return []
    // 用户亲手选过的目录才允许后续写回，避免渲染进程（含插件）拿到任意路径写文件的能力
    for (const p of r.filePaths) authorize(path.dirname(p))
    return r.filePaths
  }))

  ipcMain.handle('dialog:pickFolder', wrap(async (_e, { defaultPath } = {}) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath })
    if (r.canceled) return null
    authorize(r.filePaths[0])
    return r.filePaths[0]
  }))

  ipcMain.handle('files:writeBatch', wrap(async (event, { dir, items = [] }) => {
    const root = guardWithinAuthorized(dir)
    await fsp.mkdir(root, { recursive: true })
    const written = []
    const failed = []
    for (const [i, item] of items.entries()) {
      const name = safeName(item.name, `file-${i + 1}`)
      const target = path.join(root, name)
      try {
        await fsp.writeFile(target, Buffer.from(item.data))
        written.push({ name, size: item.data.byteLength })
      } catch (e) {
        failed.push({ name, error: (e && e.message) || String(e) })
      }
      event.sender.send('media:progress', { phase: 'write', done: i + 1, total: items.length })
    }
    return { dir: root, written, failed }
  }))

  ipcMain.handle('files:read', wrap(async (_e, { filePaths = [] }) => {
    const out = []
    for (const p of filePaths) {
      const buf = await fsp.readFile(p)
      out.push({ path: p, name: path.basename(p), data: new Uint8Array(buf), mime: mimeOf(p) })
    }
    return out
  }))

  ipcMain.handle('files:save', wrap(async (_e, { name = 'output.pdf', data, filters = PDF_FILTERS }) => {
    const cfg = await readSettings()
    const r = await dialog.showSaveDialog({ defaultPath: path.join(cfg.downloadDir, safeName(name, 'output')), filters })
    if (r.canceled || !r.filePath) return { canceled: true }
    await fsp.mkdir(path.dirname(r.filePath), { recursive: true })
    await fsp.writeFile(r.filePath, Buffer.from(data))
    return { canceled: false, path: r.filePath, size: data.byteLength }
  }))

  ipcMain.handle('shell:openPath', wrap(async (_e, { target }) => await shell.openPath(target)))
  // 桌面工具的默认姿势：口令通常在剪贴板里，读出来预填，省一次 Ctrl+V
  ipcMain.handle('clipboard:readText', wrap(async () => clipboard.readText()))
  ipcMain.handle('shell:showItemInFolder', wrap(async (_e, { target }) => shell.showItemInFolder(target)))

  ipcMain.handle('plugins:list', wrap(async () => await plugins.listInstalled()))
  ipcMain.handle('plugins:registry', wrap(async () => await plugins.fetchRegistry()))
  ipcMain.handle('plugins:uninstall', wrap(async (_e, { id }) => await plugins.uninstall(id)))
  ipcMain.handle('plugins:install', wrap(async (event, { entry }) => {
    const r = await plugins.install(entry, (p) => event.sender.send('plugins:progress', p))
    return r
  }))
  ipcMain.handle('plugins:entryUrl', wrap(async (_e, { id, entry }) => plugins.pluginEntryUrl(id, entry)))

  ipcMain.handle('update:check', wrap(async (e) => (await getUpdater(e.sender).check(), { started: true })))
  ipcMain.handle('update:download', wrap(async (e) => (await getUpdater(e.sender).download(), { started: true })))
  ipcMain.handle('update:install', wrap(async (e) => (getUpdater(e.sender).quitAndInstall(), true)))
  ipcMain.handle('update:releasePage', wrap(async (e) => (getUpdater(e.sender).openReleasePage(), true)))
}

/**
 * updater 需要往渲染进程推事件，但注册 IPC 时窗口还不存在，
 * 所以按首个调用方（渲染进程）惰性建单例。
 */
let updater = null
function getUpdater(sender) {
  if (!updater) updater = initUpdater((payload) => sender.send('update:status', payload))
  return updater
}

async function settingsForParse() {
  const c = await readSettings()
  return {
    strategy: c.parseStrategy,
    demoApiHost: c.demoApiHost,
    nologoEndpoint: c.nologoEndpoint,
    nologoToken: c.nologoToken,
  }
}

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase()
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[ext] || 'application/octet-stream'
}
