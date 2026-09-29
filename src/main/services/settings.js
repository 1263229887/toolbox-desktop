import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { DEMO_HOST_DEFAULT } from './douyin.js'

const DEFAULTS = {
  downloadDir: path.join(os.homedir(), 'Downloads', '工具箱'),
  // seo 只覆盖图文；auto 会按 seo → demoApi → nologo 依次尝试
  parseStrategy: 'auto',
  demoApiHost: DEMO_HOST_DEFAULT,
  nologoEndpoint: 'https://nologo.code24.top/api/open/parse',
  nologoToken: '',
  // 按需下载插件的清单地址，第一阶段指向本仓库 Release 资产
  pluginRegistryUrl: 'https://github.com/1263229887/toolbox-desktop/releases/latest/download/plugins.json',
}

let cache = null

function file() {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function read() {
  if (cache) return cache
  try {
    const raw = await fsp.readFile(file(), 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function write(patch) {
  const next = { ...(await read()), ...patch }
  await fsp.mkdir(path.dirname(file()), { recursive: true })
  await fsp.writeFile(file(), JSON.stringify(next, null, 2), 'utf8')
  cache = next
  return next
}

export const defaults = () => ({ ...DEFAULTS })
