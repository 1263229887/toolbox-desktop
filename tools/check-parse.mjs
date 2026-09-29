#!/usr/bin/env node
/**
 * 解析链路的可执行自检：不开界面、不开浏览器，直接跑主进程用的同一个模块。
 * 用法：pnpm check:parse ["口令或链接"]
 */
import { extractShareUrl, parse } from '../src/main/services/douyin.js'

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

// 2) 图文：必须拿到带 aweme-images 标记的原图直链
const album = await parse(process.argv[2] || DEFAULT_NOTE, { strategy: 'auto' })
check('图文解析成功', album.items.length > 0, `via=${album.via} 张数=${album.items.length} kind=${album.kind}`)
check('图文直链全部指向图片 CDN', album.items.every((i) => /douyinpic\.com/.test(i.url)))
check('去重后无重复 tos id', new Set(album.items.map((i) => i.url.split('?')[0])).size === album.items.length)

// 3) 视频：SEO 直连必然拿不到，必须由解析接口给出不带水印的那一路
const video = await parse(process.argv[3] || DEFAULT_VIDEO, { strategy: 'auto' })
const clip = video.items.find((i) => i.type === 'video')
check('视频解析成功', !!clip, `via=${video.via} kind=${video.kind}`)
if (clip) {
  check('视频流不带水印', clip.watermarked !== true, `${clip.width}x${clip.height} ${clip.sizeBytes ? (clip.sizeBytes / 1048576).toFixed(1) + 'MB' : ''}`)
  const head = await fetch(clip.url, { headers: { Range: 'bytes=0-1' } })
  check('视频直链可裸 GET（无需 Referer）', head.status === 206 || head.status === 200, `HTTP ${head.status}`)
}

console.log(`\n链路尝试记录：`)
for (const r of [album, video]) console.log(`  [${r.kind}]`, JSON.stringify(r.attempts))
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
