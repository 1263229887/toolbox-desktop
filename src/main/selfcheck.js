import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'
import * as plugins from './services/plugins.js'
import { defaults, write as writeSettings } from './services/settings.js'

const MIME = { '.json': 'application/json', '.zip': 'application/zip', '.js': 'text/javascript' }

function serve(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''))
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }))
  })
}

/**
 * 按需下载链路的可执行自检：起一个本地静态服务当真 registry，
 * 跑的是生产同款代码（fetchRegistry → install → 协议路径解析 → uninstall）。
 * TOOLBOX_SELFCHECK=1 时由主进程入口调用，不开窗口。
 */
export async function runSelfcheck() {
  let failed = 0
  const check = (label, cond, detail = '') => {
    console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
    if (!cond) failed++
  }

  const dir = path.join(app.getAppPath(), 'dist-plugins')
  if (!fs.existsSync(path.join(dir, 'plugins.json'))) {
    console.log(`✗ 没有 ${path.relative(app.getAppPath(), dir)}/plugins.json，先跑 pnpm plugin:pack`)
    return 1
  }

  const { port, close } = await serve(dir)
  const url = `http://127.0.0.1:${port}/plugins.json`
  try {
    await writeSettings({ pluginRegistryUrl: url })
    const { plugins: list } = await plugins.fetchRegistry()
    check('读取远端清单', list.length > 0, `${list.length} 个插件`)
    if (!list.length) return 1

    const entry = list[0]
    const installed = await plugins.install(entry)
    check('下载并校验 SHA-256 后安装', installed.id === entry.id, `${installed.id}@${installed.version}`)

    const entryFile = plugins.resolveWithin(installed.id, installed.entry || 'dist/index.js')
    check('插件入口落盘', fs.existsSync(entryFile), path.relative(plugins.pluginRoot(), entryFile))

    const listed = await plugins.listInstalled()
    check('宿主能扫描到已安装插件', listed.some((p) => p.id === installed.id && p.entryExists))

    let crossed = false
    try {
      plugins.resolveWithin(installed.id, '../../etc/passwd')
    } catch {
      crossed = true
    }
    check('协议路径越界被拦', crossed)

    let tampered = false
    try {
      await plugins.install({ ...entry, sha256: 'f'.repeat(64) })
    } catch (e) {
      tampered = /SHA-256/.test(e.message)
    }
    check('指纹不符时拒绝安装', tampered)

    await plugins.uninstall(installed.id)
    const after = await plugins.listInstalled()
    check('卸载干净', !after.some((p) => p.id === installed.id))
  } catch (e) {
    check('自检未抛异常', false, e.message)
  } finally {
    await close()
    // 自检把清单地址临时改成了本地服务，退出前恢复默认，免得下次打开界面时还指着 127.0.0.1
    await writeSettings({ pluginRegistryUrl: defaults().pluginRegistryUrl })
  }

  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
  return failed ? 1 : 0
}
