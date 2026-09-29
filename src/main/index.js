import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, protocol, session, shell } from 'electron'
import { registerIpc } from './ipc.js'
import { PROTOCOL, resolveWithin } from './services/plugins.js'

// 抖音 CDN 认 Referer：渲染进程发媒体请求时会带上自己的来源（dev 是 localhost、打包后是 file://），
// 这两种都被判 403；实测换成 https://www.douyin.com/ 就 200/206。
const MEDIA_HOSTS = ['*://*.douyinpic.com/*', '*://*.zjcdn.com/*', '*://*.douyinvod.com/*', '*://*.byteimg.com/*', '*://*.ixigua.com/*']

const here = path.dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env.ELECTRON_RENDERER_URL

// 协议必须在 app ready 之前声明特权，否则渲染进程拿不到 fetch/import 语义
protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

const gotLock = app.requestSingleInstanceLock()

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#f7f8fa',
    title: '工具箱',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      // type:module 下 electron-vite 把 preload 输出成 .mjs；配合 sandbox:false 才能用 ESM preload
      preload: path.join(here, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (isDev) {
    // 渲染层的报错在终端里看不见，等于没测；dev 下统一转发到 stdout。
    // Electron 44：监听器只要声明第二个参数就会走「已废弃的多参数」老路径，
    // 拿不到字段还会打 deprecation 警告，所以只接 event，字段从 event 上取。
    win.webContents.on('console-message', (e) => {
      if (e.level !== 'error' && e.level !== 'warning') return
      const file = e.frame?.url ? `${e.frame.url.split('/').pop()}:${e.lineNumber}` : ''
      console.log(`[renderer:${e.level}] ${e.message}${file ? ` (${file})` : ''}`)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[renderer] did-fail-load ${code} ${desc} ${url}`))
  }

  // 插件页面/搜索结果里的外链一律交给系统浏览器，应用内不导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const inside = isDev ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : url.startsWith('file:')
    if (!inside) e.preventDefault()
  })

  if (isDev) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(here, '../renderer/index.html'))
}

if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(() => {
    app.setName('工具箱')
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: MEDIA_HOSTS }, (details, callback) => {
      details.requestHeaders.Referer = 'https://www.douyin.com/'
      callback({ requestHeaders: details.requestHeaders })
    })
    // 插件包解压在 userData 下，协议只做该目录的只读映射，越界由 resolveWithin 拦掉
    protocol.handle(PROTOCOL, async (request) => {
      const { host, pathname } = new URL(request.url)
      const file = await import('node:fs/promises').then((m) => m.readFile(resolveWithin(host, pathname)))
      const ext = path.extname(pathname)
      const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream'
      return new Response(file, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } })
    })

    registerIpc()

    if (process.env.TOOLBOX_SELFCHECK) {
      // 无界面自检：验证按需下载链路（清单→下载→校验→安装→协议→卸载）
      import('./selfcheck.js')
        .then(({ runSelfcheck }) => runSelfcheck())
        .then((code) => app.exit(code))
      return
    }

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.isMinimized() ? win.restore() : win.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
