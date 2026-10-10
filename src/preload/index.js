import { contextBridge, ipcRenderer, webUtils } from 'electron'

// 渲染进程只能按名字点这些能力；新增工具要加通道，必须同时改这张表。
const INVOKE = new Set([
  'app:info',
  'settings:get',
  'settings:set',
  'settings:reset',
  'douyin:parse',
  'douyin:author-posts',
  'douyin:batch-save',
  'douyin:batch-stop',
  'media:save',
  'dialog:pickFiles',
  'dialog:pickFolder',
  'files:read',
  'files:save',
  'files:writeBatch',
  'shell:openPath',
  'shell:showItemInFolder',
  'clipboard:readText',
  'plugins:list',
  'plugins:registry',
  'plugins:install',
  'plugins:uninstall',
  'plugins:entryUrl',
  'update:check',
  'update:download',
  'update:install',
  'update:releasePage',
])

const EVENTS = new Set(['media:progress', 'douyin:batch-progress', 'plugins:progress', 'update:status'])

contextBridge.exposeInMainWorld('toolbox', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.resolve({ ok: false, error: `未授权的通道：${channel}` })
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, listener) {
    if (!EVENTS.has(channel)) return () => {}
    const wrapped = (_e, data) => listener(data)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  // 拖拽进来的 File 拿不到 .path（contextIsolation 下该属性已被移除），只能由 preload 换算
  pathFor(file) {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})
