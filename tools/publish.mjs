#!/usr/bin/env node
/**
 * 把按需分发的产物挂到 GitHub Release。两类 tag 分开，互不影响：
 *   registry   → plugins.json（插件清单，改了插件就重传）
 *   model-<id>-<ver> → 模型包 zip（内容变了必须同时改 pack 里的版本与登记表指纹）
 *
 * 用法：GITHUB_TOKEN=xxx node tools/publish.mjs [registry|model|all]
 * 说明：不打印 token，也不把它写进任何文件；仓库地址从 electron-builder.yml 的 publish 段读取。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const token = process.env.GITHUB_TOKEN
if (!token) {
  console.log('需要 GITHUB_TOKEN 环境变量（不落盘、不写进 git）')
  process.exit(1)
}
const OWNER = '1263229887'
const REPO = 'toolbox-desktop'
const api = (p, opts = {}) =>
  fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })

async function ensureRelease(tag, name, body) {
  const found = await api(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
  if (found.status === 200) return found.json()
  const created = await api(`/repos/${OWNER}/${REPO}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false }) })
  if (!created.ok) throw new Error(`创建 release ${tag} 失败 HTTP ${created.status} ${(await created.text()).slice(0, 200)}`)
  return created.json()
}

async function upload(releaseId, file, name) {
  const buf = fs.readFileSync(file)
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
    body: buf,
  })
  if (!res.ok) throw new Error(`上传 ${name} 失败 HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  console.log(`  ✓ ${name}  ${(buf.length / 1048576).toFixed(1)} MB  → ${j.browser_download_url}`)
}

/** 同名资产要先删再传，否则 Release 上会留下两份、latest 指向不确定 */
async function replaceAsset(tag, name, file) {
  const rel = await ensureRelease(tag, tag, '按需分发产物，由 tools/publish.mjs 维护')
  const list = await (await api(`/repos/${OWNER}/${REPO}/releases/${rel.id}/assets`)).json()
  for (const a of Array.isArray(list) ? list.filter((x) => x.name === name) : []) {
    await api(`/repos/${OWNER}/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' })
    console.log(`  · 覆盖旧资产 ${name}`)
  }
  await upload(rel.id, file, name)
}

const what = process.argv[2] || 'registry'

if (what === 'registry' || what === 'all') {
  console.log('▶ 插件清单')
  await replaceAsset('registry', 'plugins.json', path.join(root, 'dist-plugins/plugins.json'))
}

if (what !== 'registry' && what !== 'all') console.log('用法：node tools/publish.mjs [registry|all]')
