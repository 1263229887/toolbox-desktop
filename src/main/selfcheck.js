import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app } from 'electron'
import * as plugins from './services/plugins.js'
import { defaults, write as writeSettings } from './services/settings.js'
import { wmDetect, wmInpaint, wmPrepare, wmStatus } from './services/inpaint.js'
import { remove as removeModel } from './services/models.js'

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

  const root = app.getAppPath()
  for (const rel of ['dist-plugins/plugins.json', 'dist-models']) {
    if (!fs.existsSync(path.join(root, rel))) {
      console.log(`✗ 缺少 ${rel}，先跑 pnpm plugin:pack 与 node tools/pack-model.mjs`)
      return 1
    }
  }
  const modelZip = path.join(root, 'dist-models/migan-1.0.0.zip')
  if (!fs.existsSync(modelZip)) {
    console.log('✗ 缺少 dist-models/migan-1.0.0.zip（模型包未构建）')
    return 1
  }

  // 静态服务挂在项目根，插件包与模型包用各自的子路径，和生产环境的目录结构一致
  const { port, close } = await serve(root)
  const url = `http://127.0.0.1:${port}/dist-plugins/plugins.json`
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

    /* ---------- 去水印：模型下载 + 推理全链路 ---------- */
    const wmEntry = list.find((p) => p.id === 'watermark-remover')
    check('清单里有去水印插件', !!wmEntry)
    await writeSettings({ modelBaseUrl: `http://127.0.0.1:${port}/dist-models` })
    let bytes = 0
    await wmPrepare('migan', (p) => (bytes = p.received || bytes))
    const st = await wmStatus()
    const m = st.find((x) => x.id === 'migan')
    check('模型包下载并双重校验指纹', !!m?.installed && !!m?.verified, `${(bytes / 1048576).toFixed(1)} MB`)

    // 合成一张带亮色文字条的图：不依赖任何私人样本，也能验证「检测跑得通 + 修复真的改了像素」
    const w = 480
    const h = 320
    const image = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const n = ((x * 7 + y * 13) % 40) - 20
      image[i] = 90 + n
      image[i + 1] = 120 + n
      image[i + 2] = 110 + n
    }
    for (let y = h - 46; y < h - 16; y++) for (let x = w - 210; x < w - 20; x++) {
      if (((x + y) >> 2) % 3) continue
      const i = (y * w + x) * 3
      image[i] = 245
      image[i + 1] = 245
      image[i + 2] = 245
    }
    const boxes = await wmDetect({ image, w, h })
    console.log(`  · 自动检测给出 ${boxes.length} 个候选框${boxes.length ? `，最高分 ${boxes[0].score}` : ''}`)

    const mask = new Uint8Array(w * h)
    for (let y = h - 50; y < h - 12; y++) for (let x = w - 214; x < w - 16; x++) mask[y * w + x] = 255
    const before = image[(h - 30) * w * 3 + 100 * 3]
    const res = await wmInpaint({ image, mask, w, h })
    let changed = 0
    for (let y = h - 46; y < h - 16; y++) for (let x = w - 210; x < w - 20; x++) {
      const i = (y * w + x) * 3
      if (Math.abs(res.image[i] - image[i]) > 4) changed++
    }
    check('修复确实改写了 mask 区域', changed > 500, `变化像素 ${changed}，改前亮度 ${before}`)
    check('修复没动 mask 之外的区域', Math.abs(res.image[10 * w * 3 + 10] - image[10 * w * 3 + 10]) < 6)
    await removeModel('migan')
    await plugins.uninstall('watermark-remover')
  } catch (e) {
    check('自检未抛异常', false, e.message)
  } finally {
    await close()
    // 自检把清单地址临时改成了本地服务，退出前恢复默认，免得下次打开界面时还指着 127.0.0.1
    await writeSettings({ ...defaults(), pluginRegistryUrl: defaults().pluginRegistryUrl })
  }

  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
  return failed ? 1 : 0
}
