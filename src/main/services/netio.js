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

function describeNetError(e) {
  const cause = e?.cause
  const code = cause?.code || e?.code || ''
  const msg = cause?.message || e?.message || String(e)
  return code ? `${msg}（${code}）` : msg
}

/**
 * 流式下载，支持断点续传。先写 .part 再改名，中断不会留下半截文件占用目标名。
 * GitHub Release 资产在国内实测只有一两百 KB/s 且常在几十 MB 处断掉，
 * 没有续传的大文件下载基本注定失败，所以这里默认带 Range 续传 + 多次退避重试。
 * timeout 是整段请求（含读 body）的上限，大文件要给到小时级。
 */
export async function downloadFile(url, dest, { headers = {}, timeout = 7200000, onProgress, signal, retries = 8, totalHint = 0 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const tmpPath = `${dest}.part`
  const expected = Number(totalHint) || 0

  for (let attempt = 0; attempt <= retries; attempt++) {
    let have = 0
    try {
      have = (await fsp.stat(tmpPath)).size
    } catch {
      have = 0
    }
    if (expected && have >= expected) break
    const send = { ...headers }
    if (have) send.Range = `bytes=${have}-`
    let res
    try {
      res = await fetch(url, { headers: send, signal: signal || AbortSignal.timeout(timeout), redirect: 'follow' })
    } catch (e) {
      // 取消信号不当成网络抖动：否则「停止」还要被重试三次才停下来
      if (signal?.aborted) throw new Error('已取消下载')
      if (attempt < retries) {
        // 连接层失败（fetch failed / ECONNRESET）不退避会瞬间打满重试
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      throw new Error(`下载失败：${describeNetError(e)}（已重试 ${retries} 次）`)
    }
    if (have && res.status === 200) have = 0 // 源不支持 Range，只能整份重来
    if (!res.ok && res.status !== 206) throw new Error(`下载失败 HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) + (res.status === 206 ? have : 0)
    const stream = fs.createWriteStream(tmpPath, { flags: res.status === 206 ? 'a' : 'w' })
    let received = res.status === 206 ? have : 0
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
    } catch (e) {
      stream.destroy()
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      throw new Error(`下载中断：${describeNetError(e)}（已收 ${received} 字节，可续传重试）`)
    }
    await new Promise((r, j) => stream.end((e) => (e ? j(e) : r())))
    if (total && received < total) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      throw new Error(`下载不完整（${received}/${total} 字节），请重试续传`)
    }
    await fsp.rename(tmpPath, dest)
    return { size: received, path: dest }
  }
  throw new Error('下载失败：重试次数用尽')
}

export const stamp = () => Date.now().toString(36)

export function safeName(name, fallback = 'untitled') {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80)
  return cleaned || fallback
}
