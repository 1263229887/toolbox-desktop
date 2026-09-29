#!/usr/bin/env node
/**
 * 组装按需下载的模型包：MI-GAN 修复模型 + OCR 文字检测 + ort-web 运行时 + 许可证。
 * 这些都不进安装包，首次使用「图片去水印」时才拉。
 *
 * 用法：node tools/pack-model.mjs <migan.onnx> <det.onnx>
 * 产物：dist-models/<id>-<version>.zip，并把 SHA-256/体积回写到 model-registry.js
 */
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const require = createRequire(import.meta.url)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = path.join(root, 'dist-models')
const [miganPath, detPath] = process.argv.slice(2)
if (!miganPath || !detPath) {
  console.log('用法：node tools/pack-model.mjs <migan_pipeline_v2.onnx> <ch_PP-OCRv4_det_mobile.onnx>')
  process.exit(1)
}

const ORT_PKG = path.join(root, 'node_modules/.pnpm/onnxruntime-web@1.30.0/node_modules/onnxruntime-web')
const COMMON_PKG = path.join(root, 'node_modules/.pnpm/onnxruntime-common@1.30.0/node_modules/onnxruntime-common')
const ORT_DIR = path.join(ORT_PKG, 'dist')
// Node/WASM 实测只需要这三个文件（缺 .mjs 胶水会报 Cannot find module ort-wasm-simd-threaded.mjs）
const ORT_FILES = ['ort.node.min.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']

const LICENSES = {
  'LICENSE-MI-GAN.txt': 'https://raw.githubusercontent.com/Picsart-AI-Research/MI-GAN/main/LICENSE',
  'LICENSE-MI-GAN-WEIGHTS.txt': 'https://raw.githubusercontent.com/Picsart-AI-Research/MI-GAN/main/LICENSE-WEIGHTS',
}

const id = 'migan'
const version = '1.0.0'

// raw.githubusercontent.com 在本机直连会超时（实测抖动很大），失败就退到系统代理再试一次。
// 许可证文本是 MIT 再分发的义务，拿不到就必须报错、不能默默少带。
function curl(url, proxy) {
  const { execFileSync } = require('node:child_process')
  const args = ['-sS', '--max-time', '40', ...(proxy ? ['-x', proxy] : []), url]
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 << 20 })
}

function text(url) {
  let last
  for (const proxy of [null, 'http://127.0.0.1:7897']) {
    try {
      const body = curl(url, proxy)
      if (body && !/^Not Found/i.test(body) && body.length > 40) return body
      last = new Error(`内容异常（${body.length} 字节）`)
    } catch (e) {
      last = e
    }
  }
  throw new Error(`取许可证失败 ${url}：${last.message}`)
}

const files = {}
files['migan_pipeline_v2.onnx'] = new Uint8Array(fs.readFileSync(miganPath))
files['ch_PP-OCRv4_det_mobile.onnx'] = new Uint8Array(fs.readFileSync(detPath))
for (const f of ORT_FILES) files[`ort/${f}`] = new Uint8Array(fs.readFileSync(path.join(ORT_DIR, f)))

// ort.node.min.mjs 里 import 的是裸包名 'onnxruntime-common'，不是自包含产物：
// 所以包里必须带一份该包，靠 Node 逐级找 node_modules 解析（只带 .js，去掉 d.ts 与 map）
for (const f of fs.readdirSync(path.join(COMMON_PKG, 'dist/esm'))) {
  if (f.endsWith('.map') || f.endsWith('.d.ts')) continue
  files[`node_modules/onnxruntime-common/dist/esm/${f}`] = new Uint8Array(fs.readFileSync(path.join(COMMON_PKG, 'dist/esm', f)))
}
// 该包目录里没有 LICENSE 文件（只有 package.json 里的 license 字段），有就带上、没有就别猜路径
for (const f of ['package.json', 'LICENSE', 'LICENSE.txt', 'NOTICE.md']) {
  const p = path.join(COMMON_PKG, f)
  if (fs.existsSync(p)) files[`node_modules/onnxruntime-common/${f}`] = new Uint8Array(fs.readFileSync(p))
}
for (const [name, url] of Object.entries(LICENSES)) files[name] = strToU8(await text(url))
files['NOTICE-OCR.txt'] = strToU8(
  'ch_PP-OCRv4_det_mobile.onnx 来自 RapidAI/RapidOCR（Apache-2.0），其模型转发自 PaddlePaddle/PaddleOCR（Apache-2.0）。\n' +
    'ort-web 来自 Microsoft ONNX Runtime（MIT）。\n' +
    'MI-GAN 代码与权重均为 Picsart AI Research 以 MIT 发布，见同包内 LICENSE 文件。\n',
)

const manifest = {
  id,
  version,
  files: Object.keys(files),
  builtAt: new Date().toISOString(),
}
files['pack.json'] = strToU8(JSON.stringify(manifest, null, 2))

const zipped = zipSync(files, { level: 6 })
const archive = `${id}-${version}.zip`
await fsp.mkdir(outDir, { recursive: true })
await fsp.writeFile(path.join(outDir, archive), Buffer.from(zipped))
const sha256 = crypto.createHash('sha256').update(Buffer.from(zipped)).digest('hex')

// 把指纹回写进登记表：产品侧拒绝加载没有 sha256 的模型包
const regPath = path.join(root, 'src/main/services/model-registry.js')
const reg = await fsp.readFile(regPath, 'utf8')
const next = reg.replace(/url: '[^']*',\n(\s*)sha256: '[^']*',\n(\s*)size: \d+,/, `url: 'https://github.com/1263229887/toolbox-desktop/releases/download/model-${id}-${version}/${archive}',\n$1sha256: '${sha256}',\n$2size: ${zipped.length},`)
await fsp.writeFile(regPath, next)

console.log(`✓ ${archive}  ${(zipped.length / 1048576).toFixed(1)} MB`)
console.log(`  sha256=${sha256}`)
console.log(next === reg ? '  ⚠ 登记表未更新（正则没匹配上，检查 model-registry.js）' : '  已回写 src/main/services/model-registry.js')
