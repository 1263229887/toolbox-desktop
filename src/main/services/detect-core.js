/**
 * 水印候选检测（PP-OCRv4 DBNet 概率图 → 框 → 启发式打分）。
 * 从 inpaint-worker 里抽出来做成纯模块，是为了能在不开界面、不起 utilityProcess
 * 的情况下对真样本跑召回统计（tools/bench/detect-recall.mjs）。
 *
 * 用 getter 传入：ort 与 session 是在 init() 里才赋值的，直接传值会拿到 undefined。
 */

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

function preprocessDet(ort, image, w, h, limit = 960) {
  const scale = Math.min(1, limit / Math.max(w, h))
  const nw = Math.max(32, Math.round((w * scale) / 32) * 32)
  const nh = Math.max(32, Math.round((h * scale) / 32) * 32)
  const out = new Float32Array(nw * nh * 3)
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh))
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw))
      const i = (sy * w + sx) * 3
      const o = y * nw + x
      for (let c = 0; c < 3; c++) out[c * nw * nh + o] = (image[i + c] / 255 - MEAN[c]) / STD[c]
    }
  }
  return { tensor: new ort.Tensor('float32', out, [1, 3, nh, nw]), nw, nh }
}

/** 概率图上的连通块外接框。不做轮廓+unclip：去水印宁可多盖一圈，也别留残影。 */
function boxesFromProb(prob, nw, nh, threshold = 0.35) {
  const seen = new Uint8Array(nw * nh)
  const boxes = []
  const stack = new Int32Array(nw * nh)
  for (let i = 0; i < nw * nh; i++) {
    if (seen[i] || prob[i] < threshold) continue
    let head = 0
    let n = 0
    let x0 = nw
    let y0 = nh
    let x1 = 0
    let y1 = 0
    stack[head++] = i
    seen[i] = 1
    while (n < head) {
      const p = stack[n++]
      const px = p % nw
      const py = (p / nw) | 0
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (const q of [p - 1, p + 1, p - nw, p + nw]) {
        if (q < 0 || q >= nw * nh || seen[q] || prob[q] < threshold) continue
        const qx = q % nw
        if (q === p - 1 && qx === nw - 1) continue
        if (q === p + 1 && qx === 0) continue
        seen[q] = 1
        stack[head++] = q
      }
    }
    boxes.push({ x0, y0, x1, y1, area: (x1 - x0 + 1) * (y1 - y0 + 1) })
  }
  return boxes
}

function luma(image, w, x, y) {
  const i = (y * w + x) * 3
  return 0.299 * image[i] + 0.587 * image[i + 1] + 0.114 * image[i + 2]
}

/**
 * 判定「这串文字像不像叠加水印」：水印是往局部叠一层半透明色，
 * 所以框内与框外的亮度差会明显——但**方向不定**：白字压深色背景是提亮，
 * 白字压近白背景（实测漏检的那张泡沫图）只有 ±2 的差，只测正向亮度就会漏。
 * 因此这里取绝对值，并允许"低对比但有笔画高频"的情况通过。
 */
function scoreCandidate(image, w, h, b) {
  const bw = b.x1 - b.x0 + 1
  const bh = b.y1 - b.y0 + 1
  if (bh > h * 0.14) return 0
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  const edgeDist = Math.min(cx, w - cx, cy, h - cy) / Math.max(w, h)
  const nearEdge = edgeDist < 0.34
  let inside = 0
  let count = 0
  for (let y = b.y0; y <= b.y1; y += 2) for (let x = b.x0; x <= b.x1; x += 2) {
    inside += luma(image, w, x, y)
    count++
  }
  const pad = Math.max(6, bh)
  let ring = 0
  let rc = 0
  for (let y = Math.max(0, b.y0 - pad); y < Math.min(h, b.y1 + pad + 1); y += 3) {
    for (let x = Math.max(0, b.x0 - pad); x < Math.min(w, b.x1 + pad + 1); x += 3) {
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) continue
      ring += luma(image, w, x, y)
      rc++
    }
  }
  const lift = rc ? inside / count - ring / rc : 0
  // 笔画级高频：水印文字边缘锐利，框内梯度能量应明显高于框外一圈
  let edgeIn = 0
  let ec = 0
  for (let y = b.y0 + 1; y < b.y1; y += 2) for (let x = b.x0 + 1; x < b.x1; x += 2) {
    edgeIn += Math.abs(luma(image, w, x + 1, y) - luma(image, w, x, y)) + Math.abs(luma(image, w, x, y + 1) - luma(image, w, x, y))
    ec++
  }
  const grad = ec ? edgeIn / ec : 0
  if (Math.abs(lift) < 6 && !(grad > 6 && nearEdge)) return 0
  return Math.min(1, (nearEdge ? 0.5 : 0.15) + Math.min(0.35, Math.abs(lift) / 60) + Math.min(0.2, bw / w))
}

/** 同一行的碎片（逐字检测出来的）合并成一条，避免漏字 */
function mergeRows(boxes) {
  const out = []
  const used = new Array(boxes.length).fill(false)
  for (let i = 0; i < boxes.length; i++) {
    if (used[i]) continue
    let a = { ...boxes[i] }
    used[i] = true
    let changed = true
    while (changed) {
      changed = false
      for (let j = 0; j < boxes.length; j++) {
        if (used[j]) continue
        const b = boxes[j]
        const vOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
        const hOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
        const minH = Math.min(a.y1 - a.y0, b.y1 - b.y0)
        const gap = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2)
        if ((vOverlap > minH * 0.5 && gap < Math.max(a.x1 - a.x0, b.x1 - b.x0) * 2) || (hOverlap > 0 && vOverlap > minH * 0.5)) {
          a = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), score: Math.max(a.score, b.score) }
          used[j] = true
          changed = true
        }
      }
    }
    out.push(a)
  }
  return out
}

export function createDetector({ getOrt, getSession }) {
  return async function detect({ image, w, h }) {
    const ort = getOrt()
    const session = getSession()
    if (!ort || !session) throw new Error('检测器尚未初始化')
    const { tensor, nw, nh } = preprocessDet(ort, image, w, h)
    const out = await session.run({ x: tensor })
    const prob = out[session.outputNames[0]].data
    const sx = w / nw
    const sy = h / nh
    const boxes = []
    for (const b of boxesFromProb(prob, nw, nh)) {
      if (b.area < 10) continue
      const full = {
        x0: Math.max(0, Math.floor(b.x0 * sx)),
        y0: Math.max(0, Math.floor(b.y0 * sy)),
        x1: Math.min(w - 1, Math.ceil(b.x1 * sx)),
        y1: Math.min(h - 1, Math.ceil(b.y1 * sy)),
      }
      const score = scoreCandidate(image, w, h, full)
      if (score <= 0) continue
      boxes.push({ ...full, score: Number(score.toFixed(3)) })
    }
    return mergeRows(boxes).sort((a, b) => b.score - a.score).slice(0, 12)
  }
}
