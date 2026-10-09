/**
 * PDF 操作（纯 pdf-lib，不碰 DOM）：界面层只负责选文件、渲染预览和传一个图像重压器，
 * 这样这些函数能被 node 直接跑回归（tools/check-pdf.mjs）。
 *
 * 传进来的 JPEG 必须是独立 Uint8Array，不能是 Buffer：pdf-lib 内部用
 * `new DataView(bytes.buffer)` 读取，而 Buffer 是内存池视图，.buffer 起点不为 0，
 * 会被判成「SOI not found in JPEG」。IPC 侧已经是 new Uint8Array(buf)，安全。
 */
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib'

export async function load(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false })
}

/** 多个 PDF 按给定顺序拼成一份 */
export async function merge(docs) {
  const out = await PDFDocument.create()
  for (const doc of docs) {
    const pages = await out.copyPages(doc, doc.getPages().map((_, i) => i))
    pages.forEach((p) => out.addPage(p))
  }
  return out
}

/** 按 1 起始页码列表各拆一份；返回 PDFDocument 数组 */
export async function split(doc, pageIndexes) {
  const out = []
  for (const i of pageIndexes) {
    const one = await PDFDocument.create()
    const [p] = await one.copyPages(doc, [i])
    one.addPage(p)
    out.push(one)
  }
  return out
}

/** 按新页序重排，可选逐页角度旋转；drop 掉的页不会出现在结果里 */
export async function organize(doc, order, rotations = {}) {
  if (!order.length) throw new Error('没有保留任何页面')
  const out = await PDFDocument.create()
  const pages = await out.copyPages(doc, order)
  pages.forEach((p, k) => {
    out.addPage(p)
    const deg = rotations[order[k]] || 0
    if (deg) p.setRotation(degrees(deg))
  })
  return out
}

/**
 * 替换 PDF 里所有内嵌 JPEG 图像。compressor 由调用方给（界面层用 canvas），
 * 返回 null 或不小于原尺寸就跳过 —— 压缩工具最怕的是"越压越大"。
 */
export async function replaceJpegImages(doc, compressor) {
  const context = doc.context
  let images = 0
  let skipped = 0
  let shrunk = 0
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!obj || typeof obj.getContents !== 'function') continue
    if (String(obj.dict?.get?.(PDFName.of('Filter'))) !== '/DCTDecode') continue
    const original = obj.getContents()
    const next = await compressor(original)
    if (!next || next.length >= original.length) {
      skipped++
      continue
    }
    obj.contents = next
    // /Length 必须同步，否则阅读器按旧长度截断图像；换图后 W/H 也要跟着 SOF 改
    obj.dict.set(PDFName.of('Length'), PDFNumber.of(next.length))
    const size = jpegSize(next)
    if (size) {
      obj.dict.set(PDFName.of('Width'), PDFNumber.of(size.w))
      obj.dict.set(PDFName.of('Height'), PDFNumber.of(size.h))
    }
    images++
    shrunk += original.length - next.length
  }
  return { images, skipped, shrunk }
}

/** JPEG SOF 头里读宽高；找不到返回 null（调用方保留原 W/H） */
export function jpegSize(buf) {
  let i = 2
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue }
    const m = buf[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] }
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
    i += 2 + ((buf[i + 2] << 8) | buf[i + 3])
  }
  return null
}

/** 「1-3,5,8-10」→ 0 起始页索引 */
export function parseRange(text, total) {
  const out = []
  for (const part of String(text || '').split(/[,，\s]+/)) {
    if (!part) continue
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const a = Number(m[1])
    const b = Number(m[2] || m[1])
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total && !out.includes(i - 1)) out.push(i - 1)
  }
  return out
}

export async function save(doc) {
  return doc.save({ useObjectStreams: false })
}

/** 九宫格位置 → 左下角原点坐标（PDF 的 y 轴向上） */
export function placementXY(placement, pageW, pageH, w, h, margin = 18) {
  const [row, col] = {
    'top-left': ['top', 'left'], 'top-center': ['top', 'center'], 'top-right': ['top', 'right'],
    'center-left': ['middle', 'left'], 'center': ['middle', 'center'], 'center-right': ['middle', 'right'],
    'bottom-left': ['bottom', 'left'], 'bottom-center': ['bottom', 'center'], 'bottom-right': ['bottom', 'right'],
  }[placement] || ['bottom', 'center']
  const x = col === 'left' ? margin : col === 'right' ? pageW - w - margin : (pageW - w) / 2
  const y = row === 'top' ? pageH - h - margin : row === 'middle' ? (pageH - h) / 2 : margin
  return { x, y }
}

/** 平铺水印的网格坐标（带页内裁剪由调用方决定宽高） */
export function tilePositions(pageW, pageH, w, h, gapX, gapY, angle) {
  const out = []
  const stepX = w + gapX
  const stepY = h + gapY
  const reach = angle ? Math.hypot(pageW, pageH) : pageH
  for (let y = -stepY; y < reach + stepY; y += stepY) {
    for (let x = -stepX; x < pageW + stepX; x += stepX) {
      out.push({ x, y: angle ? y : pageH - y - h })
    }
  }
  return out
}

/**
 * 给指定页盖一层带透明通道的 PNG —— 文字水印与页码都走这里。
 * 不嵌字体：pdf-lib 的 embedFont 不处理 .ttc 字体集合（Windows 的中文字体基本都是集合），
 * 打包中文字体又是几 MB 起步还牵扯授权，所以中文交给 canvas 渲染成图，用系统字体、所见即所得。
 * makeOverlay(page, index) 返回 { bytes, width, height, x, y, opacity } 或 null（跳过该页）。
 */
export async function stampPages(doc, targets, makeOverlay) {
  const pages = doc.getPages()
  let stamped = 0
  for (const i of targets) {
    const page = pages[i]
    if (!page) continue
    const ov = await makeOverlay(page, i)
    if (!ov || !ov.bytes) continue
    const img = await doc.embedPng(ov.bytes)
    page.drawImage(img, { x: ov.x, y: ov.y, width: ov.width, height: ov.height, opacity: ov.opacity ?? 1 })
    stamped++
  }
  return stamped
}

/** 平铺：同一张图重复贴多次，只嵌一次 */
export async function tileStamp(doc, targets, overlay) {
  const pages = doc.getPages()
  const img = await doc.embedPng(overlay.bytes)
  let stamped = 0
  for (const i of targets) {
    const page = pages[i]
    if (!page) continue
    const { width: w, height: h } = overlay
    for (const pos of tilePositions(page.getWidth(), page.getHeight(), w, h, overlay.gapX, overlay.gapY, overlay.angle)) {
      page.drawImage(img, { x: pos.x, y: pos.y, width: w, height: h, opacity: overlay.opacity ?? 1, rotate: overlay.angle ? { type: 'deg', value: overlay.angle } : undefined })
    }
    stamped++
  }
  return stamped
}

export function readMetadata(doc) {
  return {
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '',
    creator: doc.getCreator() || '',
    producer: doc.getProducer() || '',
  }
}

export function writeMetadata(doc, meta) {
  const map = { title: 'setTitle', author: 'setAuthor', subject: 'setSubject', keywords: 'setKeywords', creator: 'setCreator', producer: 'setProducer' }
  for (const [k, fn] of Object.entries(map)) {
    if (meta[k] === undefined) continue
    // setXxx(undefined) 会被 pdf-lib 的校验器拒掉（要求 string），清空只能写空串
    doc[fn](String(meta[k]))
  }
  return doc
}
