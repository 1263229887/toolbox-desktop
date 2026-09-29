#!/usr/bin/env node
/**
 * 把 plugins/<id> 构建成可分发的 zip，并生成宿主清单读取的 plugins.json。
 * 用法：node tools/pack-plugin.mjs [img-compress ...]   （缺省打包 plugins 下全部）
 * 产物：dist-plugins/<id>-<version>.zip + dist-plugins/plugins.json
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { zipSync, strToU8 } from 'fflate'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pluginsDir = path.join(root, 'plugins')
const outDir = path.join(root, 'dist-plugins')

const requested = process.argv.slice(2)
const ids = requested.length ? requested : fs.readdirSync(pluginsDir).filter((n) => fs.existsSync(path.join(pluginsDir, n, 'manifest.json')))

await fsp.mkdir(outDir, { recursive: true })
const manifestIndex = []

for (const id of ids) {
  const dir = path.join(pluginsDir, id)
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  if (manifest.id !== id) throw new Error(`${id}: manifest.id（${manifest.id}）与目录名不一致`)

  console.log(`\n▶ 构建 ${id}@${manifest.version}`)
  await build({
    configFile: path.join(dir, 'vite.config.js'),
    root: dir,
    logLevel: 'warn',
  })

  // zip 根即插件根：manifest.json + dist/*，解压后整体替换 <pluginRoot>/<id>
  const files = {}
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  const dist = path.join(dir, 'dist')
  for (const name of fs.readdirSync(dist)) {
    files[`dist/${name}`] = new Uint8Array(await fsp.readFile(path.join(dist, name)))
  }
  const zipped = zipSync(files, { level: 6 })
  const archive = `${manifest.id}-${manifest.version}.zip`
  await fsp.writeFile(path.join(outDir, archive), Buffer.from(zipped))

  const sha256 = crypto.createHash('sha256').update(Buffer.from(zipped)).digest('hex')
  manifestIndex.push({
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    icon: manifest.icon,
    category: manifest.category,
    version: manifest.version,
    file: encodeURI(archive),
    sha256,
    size: zipped.length,
    minHostVersion: manifest.minHostVersion,
    capabilities: manifest.capabilities || [],
  })
  console.log(`  ${(zipped.length / 1024).toFixed(1)} KB  sha256=${sha256.slice(0, 16)}…`)
}

const index = { generatedAt: new Date().toISOString(), plugins: manifestIndex }
await fsp.writeFile(path.join(outDir, 'plugins.json'), JSON.stringify(index, null, 2))
console.log(`\n✓ 清单 → ${path.relative(root, outDir)}/plugins.json（${manifestIndex.length} 个插件）`)
