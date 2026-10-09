#!/usr/bin/env node
/**
 * PDF 工具的可执行回归：直接 import 界面层用的同一个 ops.js（纯 pdf-lib、不碰 DOM），
 * 所以合并/拆分/旋转/页码解析/图像流替换这些逻辑不需要开界面就能验。
 */
import fs from 'node:fs'
import { PDFDocument, PDFName } from 'pdf-lib'
import { load, merge, split, organize, parseRange, replaceJpegImages, jpegSize, save, stampPages, tilePositions, placementXY, readMetadata, writeMetadata } from '../src/renderer/src/tools/pdf/ops.js'

let failed = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}

// 必须拷成独立 Uint8Array：pdf-lib 内部用 new DataView(bytes.buffer) 读，
// 而 Buffer 是内存池的视图，.buffer 的起点不是本文件开头 → 会被判成「SOI not found」
const readU8 = (n) => new Uint8Array(fs.readFileSync(new URL(`fixtures/${n}`, import.meta.url)))
const bigJpeg = readU8('jpeg-large.bin')
const smallJpeg = readU8('jpeg-small.bin')

async function docWithPages(n) {
  const d = await PDFDocument.create()
  for (let i = 0; i < n; i++) d.addPage([300 + i, 200])
  return d
}

// 1) 合并
const a = await docWithPages(3)
const b = await docWithPages(2)
const merged = await merge([a, b])
check('合并保留全部页', merged.getPageCount() === 5, `${merged.getPageCount()} 页`)
check('合并后页尺寸来自原文件', Math.round(merged.getPages()[3].getWidth()) === 300, `第4页宽 ${Math.round(merged.getPages()[3].getWidth())}`)

// 2) 拆分
const parts = await split(merged, [0, 2, 4])
check('按页拆分成多份', parts.length === 3 && parts.every((p) => p.getPageCount() === 1))
check('拆分后页尺寸与源页一致', Math.round(parts[2].getPages()[0].getWidth()) === 301, `第5页宽 ${Math.round(parts[2].getPages()[0].getWidth())}`)

// 3) 重排 + 旋转
const ordered = await organize(merged, [4, 0, 1], { 4: 90, 0: 180 })
check('整理后只保留选中页', ordered.getPageCount() === 3)
const rot = ordered.getPages()[0].getRotation()
check('旋转角度写入生效', rot.angle === 90, JSON.stringify(rot))
let threw = false
try {
  await organize(merged, [])
} catch {
  threw = true
}
check('清空全部页时拒绝执行', threw)

// 4) 页码范围解析
check('页码范围解析', JSON.stringify(parseRange('1-3,5,99,2', 6)) === JSON.stringify([0, 1, 2, 4]), JSON.stringify(parseRange('1-3,5,99,2', 6)))
check('非法范围返回空', parseRange('abc', 6).length === 0)

// 5) 图像流替换（PDF 压缩的核心）
const imgDoc = await PDFDocument.create()
const embedded = await imgDoc.embedJpg(bigJpeg)
const p = imgDoc.addPage([100, 100])
p.drawImage(embedded, { x: 0, y: 0, width: 100, height: 100 })
const pdfBytes = await imgDoc.save()

const reloaded = await load(pdfBytes)
const stat = await replaceJpegImages(reloaded, () => smallJpeg)
check('识别并替换 DCTDecode 图像流', stat.images === 1, JSON.stringify(stat))
check('体积确实变小', stat.shrunk === bigJpeg.length - smallJpeg.length, `省 ${stat.shrunk}B`)

const out = await save(reloaded)
const verify = await load(out)
let found = null
for (const [, obj] of verify.context.enumerateIndirectObjects()) {
  if (obj?.getContents && String(obj.dict?.get?.(PDFName.of('Filter'))) === '/DCTDecode') found = obj
}
check('新 PDF 里图像字节已换成小的', found && found.getContents().length === smallJpeg.length)
check('/Length 已同步', found && Number(String(found.dict.get(PDFName.of('Length')))) === smallJpeg.length)
check('W/H 与 JPEG SOF 一致', found && Number(String(found.dict.get(PDFName.of('Width')))) === jpegSize(smallJpeg).w)

// 6) 越压越大时必须跳过，不能反效果
const guardDoc = await load(pdfBytes)
const guard = await replaceJpegImages(guardDoc, () => new Uint8Array(bigJpeg.length + 500))
check('替换后变大时跳过', guard.images === 0 && guard.skipped === 1, JSON.stringify(guard))
const noop = await replaceJpegImages(await load(pdfBytes), () => null)
check('解码失败时保留原图', noop.images === 0 && noop.skipped === 1)

// 7) 盖章式水印 / 页码（不嵌字体那条路线）
const wmPng = readU8('wm.png')
const stampDoc = await docWithPages(2)
const stamped = await stampPages(stampDoc, [0, 1], async (page) => {
  const { x, y } = placementXY('bottom-right', page.getWidth(), page.getHeight(), 120, 32)
  return { bytes: wmPng, width: 120, height: 32, x, y, opacity: 0.5 }
})
check('两页都盖上水印', stamped === 2, `${stamped} 页`)
const stampOut = await save(stampDoc)
const stampBack = await load(stampOut)
check('盖章后仍可重新载入且页数不变', stampBack.getPageCount() === 2)
let pngCount = 0
for (const [, obj] of stampBack.context.enumerateIndirectObjects()) {
  if (obj?.getContents && String(obj.dict?.get?.(PDFName.of('Filter'))) === '/FlateDecode') pngCount++
}
check('PNG 图像已写入 PDF', pngCount >= 2, `${pngCount} 个 Flate 流`)

// 8) 坐标与平铺
const bl = placementXY('bottom-left', 300, 200, 100, 20)
const tr = placementXY('top-right', 300, 200, 100, 20)
check('左下坐标贴边', bl.x === 18 && bl.y === 18, JSON.stringify(bl))
check('右上坐标不越界', tr.x === 300 - 100 - 18 && tr.y === 200 - 20 - 18, JSON.stringify(tr))
check('平铺网格覆盖整页', tilePositions(300, 200, 60, 20, 40, 40, 0).length >= 15, `${tilePositions(300, 200, 60, 20, 40, 40, 0).length} 个位置`)

// 9) 元数据
const metaDoc = await docWithPages(1)
writeMetadata(metaDoc, { title: '季度报告', author: '张三', subject: '' })
const metaBack = await load(await save(metaDoc))
const got = readMetadata(metaBack)
check('元数据写入并可读回', got.title === '季度报告' && got.author === '张三', JSON.stringify({ t: got.title, a: got.author }))

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
