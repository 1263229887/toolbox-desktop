// 验证 pdf-lib 能否原地替换内嵌 JPEG 流并写出结构合法的 PDF —— 「PDF 压缩」方案的前提。
// 结论决定实现路线：能，就用纯 JS（MIT 的 pdf-lib）；不能就得引外部二进制。
import fs from 'node:fs'
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib'

const jpeg = fs.readFileSync('/tmp/small.jpg')
const small = fs.readFileSync('/tmp/smaller.jpg')

const mk = await PDFDocument.create()
const img = await mk.embedJpg(jpeg)
const page = mk.addPage([400, 400])
page.drawImage(img, { x: 0, y: 0, width: 400, height: 400 })
const base = await mk.save()
fs.writeFileSync('/tmp/proof-base.pdf', base)

const doc = await PDFDocument.load(base, { updateMetadata: false })
const ctx = doc.context
let found = 0

for (const [, obj] of ctx.enumerateIndirectObjects()) {
  if (!obj || typeof obj.getContents !== 'function') continue
  const filter = obj.dict?.get?.(PDFName.of('Filter'))
  if (String(filter) !== '/DCTDecode') continue
  found++
  const before = obj.getContents().length
  obj.contents = small // PDFRawStream.contents 是普通可写字段
  obj.dict.set(PDFName.of('Length'), PDFNumber.of(small.length))
  const sof = readJpegSize(small)
  if (sof) {
    obj.dict.set(PDFName.of('Width'), PDFNumber.of(sof.w))
    obj.dict.set(PDFName.of('Height'), PDFNumber.of(sof.h))
  }
  console.log(`DCTDecode 图像流 #${found}: ${before}B → ${small.length}B，SOF 尺寸 ${sof?.w}x${sof?.h}`)
}

const out = await doc.save({ useObjectStreams: false })
fs.writeFileSync('/tmp/proof-out.pdf', out)
console.log(`\nPDF 体积 ${base.length}B → ${out.length}B（省 ${((1 - out.length / base.length) * 100).toFixed(1)}%）`)

const reload = await PDFDocument.load(out)
let same = 0
for (const [, obj] of reload.context.enumerateIndirectObjects()) {
  if (obj?.getContents && String(obj.dict?.get?.(PDFName.of('Filter'))) === '/DCTDecode') {
    const c = obj.getContents()
    if (c.length === small.length && c[10] === small[10]) same++
  }
}
console.log(`重新载入成功：页数 ${reload.getPageCount()}，图像流字节一致 ${same}/${found}`)
console.log(same === found && found > 0 ? '\n✓ 方案成立：纯 pdf-lib 可以换图，不需要外部二进制' : '\n✗ 方案不成立')

function readJpegSize(buf) {
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
