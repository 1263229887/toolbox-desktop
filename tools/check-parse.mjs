#!/usr/bin/env node
/**
 * 解析链路的可执行自检：不开界面、不开浏览器，直接跑主进程用的同一个模块。
 * 用法：pnpm check:parse ["口令或链接"]
 */
import { authorPosts, extractShareUrl, isVideoUrl, parse, secUidFrom } from '../src/main/services/douyin.js'

const DEFAULT_NOTE = 'https://v.douyin.com/RcjSxXKyEr8/'
const DEFAULT_VIDEO = 'https://v.douyin.com/i2e9yYEe/'

let failed = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}

// 1) 口令提取：真实分享文案里链接前后都是噪声
const messy = '6.94 复制打开抖音，看看【某人的作品】标题 https://v.douyin.com/abc123/ :6pm w@f.BT 11/17 SYm:/'
check('从整段口令里取链接', extractShareUrl(messy) === 'https://v.douyin.com/abc123', extractShareUrl(messy))

// 2) 视频/图片分类：兜底接口的视频直链没有 .mp4 后缀，只看后缀会把视频存成坏 .jpg
const VIDEO_URL = 'https://v5-hl-mly-ov.zjcdn.com/d8b059/video/tos/cn/tos-cn-ve-15/oM1514/?a=6383&mime_type=video_mp4&qs=0'
const IMAGE_URL = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c001/okU6AA5h~tplv-dy-aweme-images:q75.webp?biz_tag=aweme_images'
check('无后缀的 zjcdn 视频链判为视频', isVideoUrl(VIDEO_URL))
check('douyinpic 原图判为图片', !isVideoUrl(IMAGE_URL))
check('.mp4 判为视频', isVideoUrl('https://x.com/a.mp4?t=1'))
check('.jpg 判为图片', !isVideoUrl('https://x.com/a.jpg'))

// 3) 图文：必须拿到带 aweme-images 标记的原图直链
const album = await parse(process.argv[2] || DEFAULT_NOTE, { strategy: 'auto' })
check('图文解析成功', album.items.length > 0, `via=${album.via} 张数=${album.items.length} kind=${album.kind}`)
check('图文直链全部指向图片 CDN', album.items.every((i) => /douyinpic\.com/.test(i.url)))
check('去重后无重复 tos id', new Set(album.items.map((i) => i.url.split('?')[0])).size === album.items.length)

// 4) 视频：SEO 直连必然拿不到，必须由解析接口给出不带水印的那一路
const video = await parse(process.argv[3] || DEFAULT_VIDEO, { strategy: 'auto' })
const clip = video.items.find((i) => i.type === 'video')
check('视频解析成功', !!clip, `via=${video.via} kind=${video.kind}`)
if (clip) {
  check('视频流不带水印', clip.watermarked !== true, `${clip.width}x${clip.height} ${clip.sizeBytes ? (clip.sizeBytes / 1048576).toFixed(1) + 'MB' : ''}`)
  // 断言产品真正走的那条路径：主进程下载用 Googlebot UA + 抖音 Referer。
  // 裸 GET 能不能通取决于 CDN 当天的 Referer 策略，不是我们要依赖的契约。
  const head = await fetch(clip.url, { headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)', Referer: 'https://www.douyin.com/', Range: 'bytes=0-1' } })
  check('按生产用的 UA+Referer 可取流', head.status === 206 || head.status === 200, `HTTP ${head.status} ${head.headers.get('content-type')}`)
}

// 5) 作者维度：一次调用就得带回可下载直链 + 作者标识，否则「先列表、再勾选、只下选中的」不成立
check('从主页链接取 sec_uid', secUidFrom('https://www.douyin.com/user/MS4wLjABAAAAtest123?x=1') === 'MS4wLjABAAAAtest123')
check('裸 sec_uid 原样通过', secUidFrom('MS4wLjABAAAAtest123') === 'MS4wLjABAAAAtest123')
check('作品链接不被误判成主页', secUidFrom('https://www.douyin.com/video/123') === '')
const secUid = video.author?.secUid || ''
check('单条解析已带作者 sec_uid（省掉一次二次请求）', /^MS4wLjAB/.test(secUid), `${secUid.slice(0, 20)}…`)
if (secUid) {
  const page = await authorPosts(secUid)
  check('作品列表非空', page.items.length > 0, `${page.items.length} 条 hasMore=${page.hasMore}`)
  const ready = page.items.filter((p) => !p.needsParse)
  check('列表条目自带无水印直链', ready.length >= Math.ceil(page.items.length * 0.6), `${ready.length}/${page.items.length} 条无需再解析`)
  check('每条都有 id / 标题 / 落地页', page.items.every((p) => p.id && p.webUrl && p.title !== undefined))
  if (ready[0]) check('视频直链指向抖音自家 CDN', /zjcdn|douyinvod|bytecdn/.test(ready[0].items[0].url), ready[0].items[0].url.split('/')[2])
  if (page.cursor) {
    // 实测连发两次 user/posts 就会命中上游风控（身份冷却 60s），所以这里两种结果都算通过：
    // 拿到不重复的下一页，或者给出「照它说的秒数退避」的结构化错误。
    try {
      const next = await authorPosts(secUid, { cursor: page.cursor })
      check('游标翻页拿到不重复的下一页', next.items.length > 0 && !next.items.some((p) => page.items.some((q) => q.id === p.id)), `${next.items.length} 条`)
    } catch (e) {
      check('被风控时带 retryAfter（客户端照秒数退避，不自己猜）', e.code === 'UPSTREAM_RISK_CONTROL' && e.retryAfter > 0, `${e.code || e.name} · ${e.message.slice(0, 46)}`)
    }
  }
}

console.log(`\n链路尝试记录：`)
for (const r of [album, video]) console.log(`  [${r.kind}]`, JSON.stringify(r.attempts))
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
