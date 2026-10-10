/**
 * 预览层：只负责「把一页画出来」，改写 PDF 仍然全部走 pdf-lib，两边互不依赖。
 * 预览挂了不影响导出结果，所以调用方一律按「可选能力」处理。
 */
let boot = null

async function bootPdfjs() {
  if (!boot) {
    boot = (async () => {
      const [lib, { default: workerSource }] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?raw'),
      ])
      // 打包后渲染层跑在 file://（asar）上，pdfjs 默认按 URL 起 worker 那条路不稳；
      // 直接把 worker 源码内联成 blob 交给 workerPort —— 实测 Electron 44 在 dev 和 file:// 下都能起
      const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
      lib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' })
      return lib
    })().catch((e) => {
      boot = null
      throw e
    })
  }
  return boot
}

export async function openPreview(bytes) {
  const lib = await bootPdfjs()
  // pdfjs 会把 ArrayBuffer transfer 给 worker，必须给副本，否则同一份 bytes 再喂 pdf-lib 就是空的
  return lib.getDocument({ data: bytes.slice() }).promise
}

/**
 * 按目标 CSS 宽度渲染一页（自动吃 devicePixelRatio），画完再调 paint(ctx, viewportTransform)。
 * 被新的渲染打断时返回 null，调用方直接放弃这次结果。
 */
export async function renderPage(page, canvas, cssWidth, paint, options = {}) {
  const dpr = window.devicePixelRatio || 1
  const base = page.getViewport({ scale: 1, rotation: options.rotation })
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr, rotation: options.rotation })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.round(viewport.width / dpr)}px`
  canvas.style.height = `${Math.round(viewport.height / dpr)}px`
  const ctx = canvas.getContext('2d')
  if (canvas._tbTask) canvas._tbTask.cancel()
  const task = page.render({ canvasContext: ctx, viewport })
  canvas._tbTask = task
  try {
    await task.promise
  } catch (e) {
    if (e?.name === 'RenderingCancelledException') return null
    throw e
  } finally {
    if (canvas._tbTask === task) canvas._tbTask = null
  }
  if (paint) await paint(ctx, viewport.transform)
  return viewport
}

/**
 * 缩略图串行队列。pdfjs 解析在 worker，但画布绘制跑在主线程，
 * 几十页同时渲染会把界面钉住，所以一次只画一张。
 */
let chain = Promise.resolve()
export function serialize(job) {
  const run = chain.then(job, job)
  chain = run.catch(() => {})
  return run
}
