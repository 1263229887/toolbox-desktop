import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const UA = {
  // 抖音只对爬虫 UA 做 SEO 服务端渲染；普通浏览器 UA 拿到的是不含数据的空壳页。
  bot: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

const json = (v) => JSON.stringify(v)

export async function request(url, { method = 'GET', headers = {}, body, timeout = 20000, redirect = 'follow' } = {}) {
  const init = {
    method,
    redirect,
    signal: AbortSignal.timeout(timeout),
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
  }
  if (body !== undefined) init.body = typeof body === 'string' ? body : json(body)

  const res = await fetch(url, init)
  const buffer = Buffer.from(await res.arrayBuffer())
  const setCookies = (res.headers.getSetCookie?.() || []).map((line) => String(line).split(';')[0])
  return {
    status: res.status,
    ok: res.ok,
    url: res.url,
    headers: Object.fromEntries(res.headers.entries()),
    setCookies,
    text: () => buffer.toString('utf8'),
    buffer,
    json: () => JSON.parse(buffer.toString('utf8')),
  }
}

export async function getJson(url, opts = {}) {
  const res = await request(url, { headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) }, ...opts })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`)
  return res.json()
}

/**
 * 流式下载。先写 .part 再改名，中断不会留下半截文件占用目标名。
 * 大文件（模型包）后续可加 Range 续传，这里先保证单文件语义正确。
 */
export async function downloadFile(url, dest, { headers = {}, timeout = 300000, onProgress, signal } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { headers, signal: signal || AbortSignal.timeout(timeout), redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || 0
  const tmpPath = `${dest}.part`
  const stream = fs.createWriteStream(tmpPath)
  let received = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      received += chunk.length
      if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
      onProgress?.({ received, total })
    }
  } catch (err) {
    stream.destroy()
    await fsp.rm(tmpPath, { force: true })
    throw err
  }
  await new Promise((r, j) => stream.end((e) => (e ? j(e) : r())))
  await fsp.rename(tmpPath, dest)
  return { size: received, path: dest }
}

export const stamp = () => Date.now().toString(36)

export function safeName(name, fallback = 'untitled') {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80)
  return cleaned || fallback
}
