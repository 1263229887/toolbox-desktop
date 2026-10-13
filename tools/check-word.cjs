#!/usr/bin/env node
/**
 * Word→PDF 工具的可执行回归，对齐 check-pdf 的口径：
 *  - docx→HTML：界面用 mammoth 浏览器构建，这里用同一个包（node 解析到 node 构建），
 *    转换语义相同，不需要开界面。
 *  - HTML→PDF：必须开 Chromium（printToPDF 藏在 electron 里），所以 `node tools/check-word.cjs`
 *    只验前半段，`electron tools/check-word.cjs` 跑完整链路（package.json 的 check:word）。
 *
 * 注意本文件必须是 CJS：这台开发机上，裸 electron 直接跑 ESM 入口时 Chromium 子进程
 * 孵化不出来（ready 不触发、只剩主进程单进程挂死）；dev/打包应用的主进程都是 CJS，不受影响。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { zipSync, strToU8 } = require('fflate')

let failed = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}

async function main() {
  // —— 造一个最小 docx（zip 四个成员就够 mammoth 解析）：标题样式段 + 加粗混排 ——
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>转换验证标题</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗文本</w:t></w:r><w:r><w:t>，与普通中文段落 English 混排。</w:t></w:r></w:p>
</w:body></w:document>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  // 引用了 pStyle 就必须给出定义，否则 mammoth 报「style referenced but not defined」
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`

  const docx = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(styles),
  })

  // —— docx → HTML ——
  // 入参名两个构建不一样：浏览器构建只认 arrayBuffer（界面那边传的就是它），
  // node 构建只认 buffer/path —— 这里按 node 的来。
  const mammoth = require('mammoth')
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: docx.slice().buffer })
  check('标题文字进 HTML', html.includes('转换验证标题'))
  check('加粗转 <strong>', html.includes('<strong>加粗文本</strong>'))
  check('中文与英文混排无丢字', html.includes('，与普通中文段落 English 混排。'))
  check('无转换警告', messages.length === 0, messages.map((m) => m.message).join('；'))
  check('坏文件报错可读', await rejects('不是一个 docx'), '')

  if (!process.versions.electron) {
    console.log('\n（node 环境：只验了 docx→HTML；HTML→PDF 用 electron tools/check-word.cjs 验）')
    process.exit(failed ? 1 : 0)
  }

  // —— HTML → PDF（真实走 src/main/services/printtopdf.js 的离屏窗口）——
  const { app } = require('electron')
  // bare 脚本没有常驻窗口：隐藏窗口 destroy 后会触发默认的「窗口全关即退出」，
  // 把后续断言一起带走；挂个空监听保住进程（生产应用有主窗口，不走这段逻辑）
  app.on('window-all-closed', () => {})
  if (!app.isReady()) await new Promise((r) => app.once('ready', r))
  // 看门狗：无头 Electron 卡死时别陪着挂，90 秒强退
  const watchdog = setTimeout(() => {
    console.log('✗ 看门狗：90 秒内没跑完，Electron 无头进程疑似卡死')
    process.exit(3)
  }, 90000)
  const { htmlToPdf } = await import('../src/main/services/printtopdf.js')
  const { PDFDocument } = require('pdf-lib')

  const png = fs.readFileSync(path.join(__dirname, 'fixtures/wm.png'))
  const imgUri = `data:image/png;base64,${png.toString('base64')}`
  const withImage = `${html}<p><img src="${imgUri}" width="160"></p><p>图片上方这行用于确认顺序。</p>`

  const bytes = await htmlToPdf(withImage, { pageSize: 'A4' })
  const doc = await PDFDocument.load(bytes)
  check('输出可被 pdf-lib 重新载入', doc.getPageCount() === 1, `${bytes.length} 字节`)
  // Chromium 的 A4 落在 595.x pt，四舍五入后可能报 595 或 596，卡死等值反而脆
  check('A4 页宽 ≈595pt', Math.abs(doc.getPage(0).getWidth() - 595) <= 1.5, `${Math.round(doc.getPage(0).getWidth())}pt`)

  const multi = await htmlToPdf(`${html}<div style="height:3000px"></div><p>应在第二页</p>`)
  const multiDoc = await PDFDocument.load(multi)
  check('超高内容自动分页', multiDoc.getPageCount() >= 2, `${multiDoc.getPageCount()} 页`)

  const land = await htmlToPdf(html, { landscape: true })
  const landDoc = await PDFDocument.load(land)
  check('横向页宽 > 页高', landDoc.getPage(0).getWidth() > landDoc.getPage(0).getHeight(), `${landDoc.getPage(0).getWidth()}x${landDoc.getPage(0).getHeight()}`)

  const out = path.join(os.tmpdir(), 'word2pdf-check.pdf')
  fs.writeFileSync(out, bytes)
  console.log(`\n样张已写到 ${out}（可打开目检图片与中文渲染）`)
  process.exit(failed ? 1 : 0)
}

async function rejects(docHint) {
  try {
    const mammoth = require('mammoth')
    await mammoth.convertToHtml({ buffer: Buffer.from(docHint) })
    return false
  } catch {
    return true
  }
}

main().catch((e) => {
  console.log('✗ 未预期异常：' + ((e && e.stack) || e))
  process.exit(1)
})
