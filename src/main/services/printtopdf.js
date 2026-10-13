import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

const PAGE_SIZES = new Set(['A3', 'A4', 'A5', 'Letter', 'Legal'])

/**
 * 离屏渲染 HTML → PDF。排版走 Chromium 自带的引擎，系统字体（含中文）和
 * <img> data URI 都是现成能力，零原生依赖；docx→HTML 的部分在渲染层由 mammoth 完成。
 * 隐藏窗口调用 printToPDF 时 Chromium 会强制完整渲染一次，不需要 offscreen 模式。
 * HTML 走临时文件而不是 data: URL：带内嵌图片的长文档会超出导航长度上限。
 */
export async function htmlToPdf(html, { pageSize = 'A4', landscape = false } = {}) {
  const size = PAGE_SIZES.has(pageSize) ? pageSize : 'A4'
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  const file = path.join(app.getPath('temp'), `toolbox-print-${process.pid}-${Date.now()}.html`)
  const doc = /<meta\s+charset/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
  await fsp.writeFile(file, doc, 'utf8')
  try {
    const buf = await withTimeout(
      (async () => {
        // 新写的临时文件偶发被瞬时占用（典型是杀软扫一把），loadFile 报 ERR_FAILED；
        // 稍等重试就能过，重试三次仍失败才算真失败
        let lastErr
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await win.loadFile(file)
            lastErr = null
            break
          } catch (e) {
            lastErr = e
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
          }
        }
        if (lastErr) throw lastErr
        return win.webContents.printToPDF({
          printBackground: true,
          pageSize: size,
          landscape,
          margins: { top: 0.79, bottom: 0.79, left: 0.79, right: 0.79 },
        })
      })(),
      60000,
      'PDF 渲染超时（文档太大或包含异常内容）',
    )
    return new Uint8Array(buf)
  } finally {
    win.destroy()
    fsp.rm(file, { force: true }).catch(() => {})
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}
