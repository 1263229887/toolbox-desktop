import { request, getJson, UA } from './netio.js'

/**
 * 抖音解析。三条链路按顺序尝试，每条都可能是唯一能用的那条，所以失败信息要原样带出去：
 *
 *  1. seo     —— Googlebot UA 直连 www.douyin.com。抖音为 SEO 做服务端渲染，图文的 CDN 原图
 *                本身就不带水印（水印是 App 保存时才叠加的），所以拿到直链就等于拿到干净图。
 *                只覆盖图文；不需要 cookie、不需要 a_bogus / X-Bogus。
 *  2. demoApi —— 自建/公共的 Douyin_TikTok_Download_API 实例。视频必须走这类接口，
 *                因为视频页的 SEO 渲染里没有 mp4 直链（实测 0 命中）。
 *  3. nologo  —— 付费兜底，按次计费，只在用户自己填了 token 时启用。
 */

export const DEMO_HOST_DEFAULT = 'https://demo.douyin.wtf'
const IMG_HOST_RE = /https:\/\/[a-zA-Z0-9.-]*douyinpic\.com\/[^"\\<\s]+/g
const ALBUM_MARK = 'tplv-dy-aweme-images'
const ID_RE = /douyin\.com\/(?:note|video)\/(\d{6,})/
const NOISE = ['100x100', 'avatar', 'favicon', '/obj/']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const err = (e) => (e && e.message ? e.message : String(e))

export function extractShareUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s，,。、）)】]+/)
  if (!m) throw new Error('粘贴的内容里没有链接')
  return m[0].replace(/\/+$/, '')
}

/**
 * 短链先用 HEAD 跟随一次重定向，只读取最终地址，不下载作品页正文。
 * 识别到视频后可以直接走视频解析接口，避免先等 SEO 页面完整返回再失败。
 */
async function resolveShortLink(link) {
  if (!/^https?:\/\/v\.douyin\.com\//i.test(link)) return { link, kind: '' }
  try {
    const res = await request(link, { method: 'HEAD', headers: { 'User-Agent': UA.desktop }, timeout: 5000 })
    const kind = /\/video\//.test(res.url) ? 'video' : /\/note\//.test(res.url) ? 'image_album' : ''
    return { link: res.url || link, kind }
  } catch {
    // 某些网络环境会拦 HEAD；识别失败就沿用原来的完整回退链路。
    return { link, kind: '' }
  }
}

function dedupeByOrigin(urls) {
  const seen = new Set()
  const out = []
  for (const u of urls) {
    if (NOISE.some((k) => u.includes(k))) continue
    // 同一张原图在页面里会出现多个尺寸变体，用 tos 路径去重才能保住顺序
    const m = u.match(/\/(tos-cn-i-[a-z0-9]+(?:c\d+)?\/[^~/]+)/)
    const key = m ? m[1] : u.split('?')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push(u)
  }
  return out
}

function metaContent(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`)) || html.match(new RegExp(`<meta[^>]+property="${name}"[^>]+content="([^"]*)"`))
  return m ? m[1] : ''
}

function pickExt(url) {
  for (const e of ['.webp', '.jpeg', '.jpg', '.png', '.heic']) if (url.includes(e)) return e
  return '.jpg'
}

async function parseViaSeo(link) {
  // 带 bot UA 跟随重定向时，短链会直接落到 note 页的 SSR 正文，省掉先取 id 的那一步
  const res = await request(link, { headers: { 'User-Agent': UA.bot }, timeout: 20000 })
  const html = res.text()
  const idMatch = res.url.match(ID_RE)
  const kind = /\/video\//.test(res.url) ? 'video' : 'image_album'

  if (html.length < 6000 || !html.includes('douyinpic')) {
    throw new Error(`风控或页面结构变更：${res.url.slice(0, 60)} 返回 ${html.length} 字节`)
  }
  const urls = dedupeByOrigin([...(html.match(IMG_HOST_RE) || [])].filter((u) => u.includes(ALBUM_MARK)))
  if (!urls.length) {
    throw new Error(kind === 'video' ? '视频作品没有图片直链，需要走解析接口' : '页面里没有图文直链（抖音可能已改 SEO 渲染）')
  }

  return {
    id: idMatch ? idMatch[1] : '',
    kind: 'image_album',
    webUrl: res.url,
    title: metaContent(html, 'description').slice(0, 120),
    author: null,
    durationMs: 0,
    stats: null,
    cover: urls[0],
    items: urls.map((u) => ({ type: 'image', url: u, ext: pickExt(u) })),
  }
}

// demo 实例的会话 cookie 有效期 7 天，每次解析都重新登录既慢又容易被限流
const demoSession = { host: '', cookie: '', expiresAt: 0 }

async function demoCookie(host) {
  if (demoSession.host === host && demoSession.cookie && Date.now() < demoSession.expiresAt) return demoSession.cookie
  const creds = await getJson(`${host}/api/v1/auth/demo`)
  if (!creds?.data?.username) throw new Error('demo 实例未开放公共账号')
  const login = await request(`${host}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: { username: creds.data.username, password: creds.data.password },
  })
  const cookie = login.setCookies.join('; ')
  if (!cookie) throw new Error(`demo 登录失败 HTTP ${login.status}`)
  const ttl = login.json()?.data?.expires_in || 604800
  demoSession.host = host
  demoSession.cookie = cookie
  // 提前 10 分钟过期，避免正好卡在边界上失败
  demoSession.expiresAt = Date.now() + (ttl - 600) * 1000
  return cookie
}

/**
 * 视频有多路流，其中一部分是带平台水印的转码流。
 * 只取 watermark=false 的那几路，按像素数排序取最高的。
 */
function pickCleanStream(media) {
  const candidates = []
  if (media.video) candidates.push(media.video)
  if (Array.isArray(media.streams)) candidates.push(...media.streams)
  const clean = candidates.filter((v) => v && v.url && v.watermark !== true)
  const list = clean.length ? clean : candidates.filter((v) => v && v.url)
  if (!list.length) return null
  return list.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0]
}

/** demo 实例的会话失效（cookie 提前被服务端作废、或实例重启）时用它触发无感重登 */
class DemoAuthExpired extends Error {}

/**
 * 上游风控。实测连拉两次 user/posts 就会命中：
 * `{code:'UPSTREAM_RISK_CONTROL', retryable:true, retry_after:60}` —— 身份进冷却 60 秒。
 * 对面是「每身份 + 每端点」的令牌桶，不是按累计条数封人，所以正确姿势是照它给的秒数退避，
 * 而不是预先按序号加大延时。
 */
export class UpstreamRisk extends Error {
  constructor(message, { retryAfter = 0, code = '' } = {}) {
    super(retryAfter ? `${message}（请 ${retryAfter} 秒后重试）` : message)
    this.name = 'UpstreamRisk'
    this.code = code
    this.retryAfter = retryAfter
    this.retryable = true
  }
}

function authExpired(res) {
  return res.status === 401 || res.json?.()?.error?.code === 'UNAUTHENTICATED'
}

/**
 * demo 实例的通用任务调用：`/api/v1/parse`、`/user/posts` 都是「提交 → 202 + task_id → 轮询」这一套契约，
 * 只有少数情况会同步返回，所以两条路都在这儿收掉。
 */
async function demoTask(path, host, { method = 'GET', body, label = '解析' } = {}) {
  const cookie = await demoCookie(host)
  const submit = await request(`${host}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie },
    ...(body ? { body } : {}),
  })
  if (authExpired(submit)) throw new DemoAuthExpired()
  if (!submit.ok) throw new Error(`提交失败 HTTP ${submit.status}`)
  const json = submit.json()
  const taskId = json?.data?.task_id
  if (!taskId) return json?.data?.data ?? json?.data ?? {}

  const pollDelays = [350, 450, 650, 850, 1100, ...Array(15).fill(1200)]
  for (const delay of pollDelays) {
    await sleep(delay)
    const poll = await request(`${host}/api/v1/tasks/${taskId}`, { headers: { Cookie: cookie, Accept: 'application/json' } })
    if (authExpired(poll)) throw new DemoAuthExpired()
    const data = poll.json()?.data
    if (!data) continue
    if (data.state === 'done') return data.data ?? {}
    if (data.state === 'failed' || data.state === 'error') {
      const e = data.error || {}
      if (e.code === 'UPSTREAM_RISK_CONTROL') throw new UpstreamRisk(e.message || '上游判定为自动化流量', { retryAfter: Number(e.retry_after) || 0, code: e.code })
      throw new Error(`${label}失败：${JSON.stringify(e || data).slice(0, 160)}`)
    }
  }
  throw new Error('解析超时（30s），稍后重试')
}

/** 会话过期就清掉缓存重新登录再跑一次，用户不需要知道中间掉过线 */
async function withDemoRetry(fn, host) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof DemoAuthExpired) || attempt === 1) throw e
      demoSession.cookie = ''
      demoSession.expiresAt = 0
    }
  }
}

async function demoParseOnce(link, host) {
  const d = await withDemoRetry(() => demoTask('/api/v1/parse', host, { method: 'POST', body: { url: link } }), host)
  const media = d.media || {}
  const items = []
  for (const img of media.images || []) {
    const u = typeof img === 'string' ? img : img?.url
    if (u) items.push({ type: 'image', url: u, ext: pickExt(u) })
  }
  const stream = pickCleanStream(media)
  if (d.kind === 'video' || (stream && !items.length)) {
    if (!stream) throw new Error('接口没有返回无水印视频流')
    items.push({
      type: 'video',
      url: stream.url,
      ext: '.mp4',
      width: stream.width || 0,
      height: stream.height || 0,
      sizeBytes: stream.size_bytes || 0,
      watermarked: stream.watermark === true,
    })
  }
  if (!items.length) throw new Error('解析结果里没有可下载的媒体')

  const cover = media.covers?.[0]?.url || ''
  return {
    id: d.content_id || '',
    kind: d.kind === 'video' ? 'video' : 'image_album',
    webUrl: d.web_url || '',
    title: d.title || d.description || '',
    // sec_uid 一定要留：接口本来就把整个 author 对象回过来了，之前只取昵称，
    // 想「看看 TA 的其他作品」就得再发一次请求才能拿到主页标识。现在同一次响应里就有。
    author: d.author?.nickname || d.author?.sec_uid
      ? {
          nickname: d.author?.nickname || '',
          secUid: d.author?.sec_uid || '',
          webUrl: d.author?.web_url || '',
          uniqueId: d.author?.unique_id || '',
        }
      : null,
    durationMs: d.duration_ms || 0,
    stats: d.stats || null,
    cover,
    items,
  }
}

/**
 * 作者维度的作品列表。一次调用就把每条的无水印直链一起带回来（实测 20 条一页、13 路流全是 watermark:false），
 * 所以批量下载不需要对每条再 parse 一次 —— 这是「先列表、再勾选、只下选中的」能成立的前提。
 */
export async function authorPosts(input, cfg = {}) {
  const host = cfg.demoApiHost || DEMO_HOST_DEFAULT
  const sec = secUidFrom(input)
  const q = new URLSearchParams()
  if (sec) q.set('sec_user_id', sec)
  else q.set('url', String(input || '').trim())
  q.set('count', String(cfg.count || 20))
  if (cfg.cursor) q.set('cursor', String(cfg.cursor))
  const data = await withDemoRetry(() => demoTask(`/api/v1/douyin/user/posts?${q}`, host, { label: '拉取作品列表' }), host)
  const items = (Array.isArray(data?.items) ? data.items : []).map(normalizePost).filter(Boolean)
  return { items, cursor: data?.cursor || '', hasMore: data?.has_more !== false, nickname: data?.items?.[0]?.author?.nickname || '' }
}

/** 主页链接 / 裸 sec_uid 都收；其余（含作品链接）交给接口自己去认 */
export function secUidFrom(input) {
  const s = String(input || '').trim()
  if (/^MS4wLjAB/.test(s)) return s.split(/[?&#/]/)[0]
  return s.match(/\/user\/(MS4wLjAB[^/?&#]+)/)?.[1] || ''
}

function normalizePost(p) {
  if (!p || !p.content_id) return null
  const kind = p.kind === 'video' ? 'video' : 'image_album'
  const items = []
  if (kind === 'video') {
    const stream = pickCleanStream(p.media || {})
    if (stream) items.push({ type: 'video', url: stream.url, ext: '.mp4', width: stream.width || 0, height: stream.height || 0, sizeBytes: stream.size_bytes || 0 })
  } else {
    for (const img of p.media?.images || []) {
      const u = typeof img === 'string' ? img : img?.url
      if (u) items.push({ type: 'image', url: u, ext: pickExt(u) })
    }
  }
  return {
    id: String(p.content_id),
    kind,
    title: String(p.title || p.description || '').slice(0, 90),
    webUrl: p.web_url || '',
    createdAt: p.created_at || 0,
    durationMs: p.duration_ms || 0,
    sizeBytes: items.reduce((n, i) => n + (i.sizeBytes || 0), 0),
    cover: p.media?.covers?.[0]?.url || p.media?.images?.[0]?.url || p.media?.video?.cover?.url || '',
    stats: p.stats || null,
    items,
    // 列表里少数条目（尤其图文）可能不带可用直链；这种退回单条解析，别在列表阶段就报错
    needsParse: !items.length,
  }
}

/**
 * 各家接口给的直链形态不一样：抖音自己的 CDN 路径里没有 .mp4，
 * 视频靠查询参数（mime_type=video_mp4）或 /video/tos/ 段区分。
 * 只看后缀会把视频误判成图片，存下来就是个坏文件。
 */
export function isVideoUrl(url) {
  const u = String(url || '')
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(u) || /mime_type=video|video_mp4|\/video\/tos\//i.test(u)
}

function collectUrls(node, out) {
  if (typeof node === 'string') {
    if (/^https?:\/\//.test(node) && /\.(jpe?g|png|webp|mp4|mov|m3u8)|douyinpic|byteimg|\/image|\/video/i.test(node) && !out.includes(node)) out.push(node)
  } else if (Array.isArray(node)) node.forEach((n) => collectUrls(n, out))
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collectUrls(n, out))
  return out
}

async function parseViaNologo(link, endpoint, token) {
  const res = await request(`${endpoint}?url=${encodeURIComponent(link)}`, { headers: { Authorization: token, Accept: 'application/json' } })
  const body = res.text()
  let data
  try { data = JSON.parse(body) } catch { throw new Error('备用接口返回的不是 JSON：' + body.slice(0, 120)) }
  const urls = collectUrls(data, [])
  if (!urls.length) throw new Error('备用接口没有返回媒体地址：' + JSON.stringify(data).slice(0, 150))
  const items = urls.map((u) => (isVideoUrl(u) ? { type: 'video', url: u, ext: '.mp4' } : { type: 'image', url: u, ext: pickExt(u) }))
  return { id: '', kind: items.some((i) => i.type === 'video') ? 'video' : 'image_album', webUrl: '', title: '', author: null, durationMs: 0, stats: null, cover: '', items }
}

export const STRATEGIES = ['auto', 'seo', 'demoApi', 'nologo']

/**
 * @param text 分享口令原文或链接
 * @param cfg  { strategy, demoApiHost, nologoEndpoint, nologoToken }
 */
export async function parse(text, cfg = {}) {
  const source = extractShareUrl(text)
  const strategy = cfg.strategy || 'auto'
  const resolved = strategy === 'auto' ? await resolveShortLink(source) : { link: source, kind: '' }
  const link = resolved.link
  const chain = strategy === 'auto' ? (resolved.kind === 'video' ? ['demoApi', 'nologo'] : ['seo', 'demoApi', 'nologo']) : [strategy]
  const attempts = []

  for (const method of chain) {
    if (method === 'nologo' && !(cfg.nologoEndpoint && cfg.nologoToken)) {
      attempts.push({ method, ok: false, message: '未配置备用接口，已跳过' })
      continue
    }
    try {
      const result =
        method === 'seo'
          ? await parseViaSeo(link)
          : method === 'demoApi'
            ? await demoParseOnce(link, cfg.demoApiHost || DEMO_HOST_DEFAULT)
            : await parseViaNologo(link, cfg.nologoEndpoint, cfg.nologoToken)
      return { ...result, source, via: method, attempts: attempts.concat({ method, ok: true, message: '' }) }
    } catch (e) {
      attempts.push({ method, ok: false, message: err(e) })
      // 风控类失败换下一条链路是有意义的；参数类失败（口令里没链接）已经在上抛了
    }
  }
  const detail = attempts.map((a) => `${a.method}: ${a.message}`).join(' / ')
  throw new Error(`三条解析链路都没成功（${detail}）`)
}
