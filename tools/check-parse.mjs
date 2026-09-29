#!/usr/bin/env node
/**
 * 解析链路的可执行自检：不开界面、不开浏览器，直接跑主进程用的同一个模块。
 * 用法：pnpm check:parse ["口令或链接"]
 */
import { extractShareUrl, isVideoUrl, parse } from '../src/main/services/douyin.js'

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

console.log(`\n链路尝试记录：`)
for (const r of [album, video]) console.log(`  [${r.kind}]`, JSON.stringify(r.attempts))
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
