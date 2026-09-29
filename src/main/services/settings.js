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
  // 按次计费的凭证不写进代码：仓库是公开的，源码和安装包里的任何常量都等于公开。
  // 放在 userData/secrets.json 里（见下），或在设置页自己填。
  nologoToken: '',
  // 按需下载插件的清单地址，第一阶段指向本仓库 Release 资产
  pluginRegistryUrl: 'https://github.com/1263229887/toolbox-desktop/releases/download/registry/plugins.json',
  // 留空 = 用 model-registry.js 里登记的地址（GitHub Release）。
  // 私有仓库的 Release 资产需要鉴权、未登录会 404，所以换境外 OSS/COS 或本地联调都走这里。
  modelBaseUrl: '',
  autoCheckUpdate: true,
  // 留空 = 用 GitHub provider；填目录 URL 则改走 generic（latest.yml 与产物需同目录）
  updateFeedUrl: '',
}

let cache = null

function file() {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function read() {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(await fsp.readFile(file(), 'utf8')) }
  } catch {
    cache = { ...DEFAULTS }
  }
  // 本机凭证文件只在存在时生效，且优先级低于用户在设置页里显式填的值
  if (!cache.nologoToken) {
    try {
      const s = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'secrets.json'), 'utf8'))
      if (s.nologoToken) cache.nologoToken = s.nologoToken
    } catch {
      /* 没有本机凭证就是没配，兜底层会被自动跳过 */
    }
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
