<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ ctx: { type: Object, required: true } })
const api = props.ctx

const img = ref(null) // { name, w, h, rgb, url }
const boxes = ref([])
const maskInfo = ref({ count: 0 })
const brush = ref(26)
const mode = ref('box')
const busy = ref('')
const err = ref('')
const model = ref(null)
const dl = ref(null)
const after = ref('')
const compare = ref(false)
const stage = ref(null)

let brushCanvas = null
let brushCtx = null
let offProgress = null

const ready = computed(() => model.value?.installed && model.value?.verified)
const hasMask = computed(() => maskInfo.value.count > 0)

async function open() {
  const paths = await api.call('dialog:pickFiles', { multiple: false })
  if (!paths?.length) return
  const [file] = await api.call('files:read', { filePaths: paths })
  busy.value = '解码中'
  err.value = ''
  try {
    const url = URL.createObjectURL(new Blob([file.data], { type: file.mime }))
    const el = await loadImage(url)
    const w = el.naturalWidth
    const h = el.naturalHeight
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(el, 0, 0)
    const rgba = g.getImageData(0, 0, w, h).data
    const rgb = new Uint8Array(w * h * 3)
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      rgb[i * 3] = rgba[j]
      rgb[i * 3 + 1] = rgba[j + 1]
      rgb[i * 3 + 2] = rgba[j + 2]
    }
    URL.revokeObjectURL(url)
    img.value = { name: file.name, w, h, rgb }
    boxes.value = []
    after.value = ''
    compare.value = false
    brushCanvas = document.createElement('canvas')
    brushCanvas.width = w
    brushCanvas.height = h
    brushCtx = brushCanvas.getContext('2d', { willReadFrequently: true })
    draw()
    if (ready.value) await detect()
  } catch (e) {
    err.value = `无法读取图片：${e.message}`
  } finally {
    busy.value = ''
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('浏览器无法解码该格式'))
    el.src = url
  })
}

async function refreshModel() {
  const list = await api.call('wm:status')
  model.value = list.find((m) => m.id === 'migan') || null
}

async function downloadModel() {
  busy.value = '下载模型'
  err.value = ''
  dl.value = { percent: 0 }
  offProgress = api.on('wm:progress', (p) => {
    if (p.total) dl.value = { percent: Math.round((p.received / p.total) * 100), received: p.received, total: p.total }
  })
  try {
    await api.call('wm:prepare', { id: 'migan' })
    await refreshModel()
    if (img.value) await detect()
  } catch (e) {
    err.value = e.message
  } finally {
    offProgress?.()
    offProgress = null
    busy.value = ''
  }
}

async function detect() {
  if (!img.value || !ready.value) return
  busy.value = '识别中'
  err.value = ''
  try {
    const list = await api.call('wm:detect', toRawImage())
    boxes.value = list.map((b) => ({ ...b, on: true }))
    draw()
    if (!boxes.value.length) err.value = '没找到疑似水印的文字区域，可用画笔手动涂一下'
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}

function toRawImage() {
  const { rgb, w, h } = img.value
  return { image: rgb, w, h }
}

/** 框选 + 画笔合成最终 mask：宁可多盖一圈，也别留残影 */
function buildMask() {
  const { w, h } = img.value
  const mask = new Uint8Array(w * h)
  for (const b of boxes.value) {
    if (!b.on) continue
    const pad = Math.max(3, Math.round((b.y1 - b.y0) * 0.35))
    const x0 = Math.max(0, b.x0 - pad)
    const y0 = Math.max(0, b.y0 - pad)
    const x1 = Math.min(w - 1, b.x1 + pad)
    const y1 = Math.min(h - 1, b.y1 + pad)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = 255
  }
  const painted = brushCtx.getImageData(0, 0, w, h).data
  let count = 0
  for (let i = 0; i < w * h; i++) {
    if (painted[i * 4 + 3] > 24) mask[i] = 255
    if (mask[i]) count++
  }
  maskInfo.value = { count }
  return mask
}

function draw() {
  const el = stage.value
  if (!el || !img.value) return
  const { w, h, rgb } = img.value
  el.width = w
  el.height = h
  const g = el.getContext('2d')
  const data = g.createImageData(w, h)
  const src = compare.value && img.value.resultRgb ? img.value.resultRgb : rgb
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    data.data[j] = src[i * 3]
    data.data[j + 1] = src[i * 3 + 1]
    data.data[j + 2] = src[i * 3 + 2]
    data.data[j + 3] = 255
  }
  g.putImageData(data, 0, 0)
  const mask = buildMask()
  g.fillStyle = 'rgba(255,64,96,0.42)'
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) g.fillRect(x, y, 1, 1)
  g.lineWidth = Math.max(1, w / 600)
  g.strokeStyle = 'rgba(255,255,255,0.85)'
  for (const b of boxes.value) {
    if (!b.on) continue
    g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
  }
}

function eventPoint(e) {
  const rect = stage.value.getBoundingClientRect()
  return { x: ((e.clientX - rect.left) / rect.width) * img.value.w, y: ((e.clientY - rect.top) / rect.height) * img.value.h }
}

let painting = false

function onDown(e) {
  if (!img.value) return
  if (mode.value === 'brush') {
    painting = true
    paint(eventPoint(e))
  } else {
    const p = eventPoint(e)
    const hit = boxes.value.findIndex((b) => p.x >= b.x0 - 4 && p.x <= b.x1 + 4 && p.y >= b.y0 - 4 && p.y <= b.y1 + 4)
    if (hit >= 0) boxes.value[hit].on = !boxes.value[hit].on
    draw()
  }
}

function onMove(e) {
  if (painting) paint(eventPoint(e))
}

function paint(p) {
  brushCtx.fillStyle = '#000'
  brushCtx.beginPath()
  brushCtx.arc(p.x, p.y, brush.value * (img.value.w / stage.value.getBoundingClientRect().width), 0, Math.PI * 2)
  brushCtx.fill()
  draw()
}

function clearBrush() {
  if (brushCtx) brushCtx.clearRect(0, 0, img.value.w, img.value.h)
  draw()
}

async function run() {
  if (!img.value || !hasMask.value) return
  busy.value = '修复中'
  err.value = ''
  try {
    const mask = buildMask()
    const res = await api.call('wm:inpaint', { ...toRawImage(), mask })
    const { w, h } = img.value
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    const data = g.createImageData(w, h)
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      data.data[j] = res.image[i * 3]
      data.data[j + 1] = res.image[i * 3 + 1]
      data.data[j + 2] = res.image[i * 3 + 2]
      data.data[j + 3] = 255
    }
    g.putImageData(data, 0, 0)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    img.value.result = new Uint8Array(await blob.arrayBuffer())
    img.value.resultRgb = res.image
    after.value = 'done'
    draw()
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}

async function save() {
  if (!img.value?.result) return
  const name = img.value.name.replace(/\.[^.]+$/, '') + '-去水印.png'
  const r = await api.call('files:save', { name, data: img.value.result })
  if (!r.canceled) err.value = ''
  savedPath.value = r.canceled ? '' : r.path
}

const savedPath = ref('')

onMounted(async () => {
  await refreshModel()
})

onBeforeUnmount(() => {
  offProgress?.()
  if (after.value) URL.revokeObjectURL(after.value)
})
</script>

<template>
  <div class="wm">
    <div class="wm-bar">
      <button class="wm-btn wm-btn-primary" @click="open"><span class="wm-dot" />打开图片</button>
      <button class="wm-btn" :disabled="!img || !ready || !!busy" @click="detect">重新识别</button>
      <div class="wm-seg">
        <button :class="{ on: mode === 'box' }" @click="mode = 'box'">点选框</button>
        <button :class="{ on: mode === 'brush' }" @click="mode = 'brush'">画笔补</button>
      </div>
      <label class="wm-range">
        笔刷
        <input v-model.number="brush" type="range" min="6" max="120" />
        <span class="wm-num">{{ brush }}</span>
      </label>
      <button class="wm-btn" :disabled="!img" @click="clearBrush">擦掉笔迹</button>
      <div class="wm-right">
        <button v-if="after" class="wm-btn" @pointerdown="compare = true; draw()" @pointerup="compare = false; draw()" @pointerleave="compare && (compare = false, draw())">按住看修复前</button>
        <button class="wm-btn" :disabled="!img || !hasMask || !!busy" @click="run">{{ busy || '执行修复' }}</button>
        <button class="wm-btn wm-btn-primary" :disabled="!img?.result" @click="save">保存 PNG</button>
      </div>
    </div>

    <div v-if="!ready" class="wm-note">
      <div class="wm-note-body">
        <strong>需要下载修复模型（约 31 MB）</strong>
        <p>MI-GAN 权重与运行时按需下载到本机，之后离线可用；不进安装包。模型只在你自己的电脑上运行，图片不会上传。</p>
      </div>
      <div>
        <div v-if="dl?.total" class="wm-track"><span class="wm-fill" :style="{ transform: `scaleX(${dl.percent / 100})` }" /></div>
        <button class="wm-btn wm-btn-primary" :disabled="!!busy" @click="downloadModel">{{ dl?.total ? `下载中 ${dl.percent}%` : '下载模型' }}</button>
      </div>
    </div>

    <p v-if="err" class="wm-warn">{{ err }}</p>
    <p v-if="savedPath" class="wm-ok">{{ savedPath }}</p>

    <div class="wm-stage">
      <canvas v-if="img" ref="stage" class="wm-canvas" :class="{ brush: mode === 'brush' }" @pointerdown="onDown" @pointermove="onMove" @pointerup="painting = false" @pointerleave="painting = false" />
      <p v-else-if="!img" class="wm-empty">打开一张图片开始。程序会自动找出疑似水印的文字，你可以点掉误判、再用画笔补上漏掉的。</p>
    </div>

    <div class="wm-foot">
      <span>{{ img ? `${img.w}×${img.h} · 候选 ${boxes.length} · 已选 ${boxes.filter((b) => b.on).length}` : '未选择图片' }}</span>
      <span class="wm-num">修复区 {{ (maskInfo.count / 1000).toFixed(0) }},000 px</span>
    </div>
  </div>
</template>

<style scoped>
.wm {
  display: flex;
  flex-direction: column;
  gap: var(--tb-space-3, 10px);
}
.wm-bar,
.wm-right,
.wm-seg {
  display: flex;
  align-items: center;
  gap: var(--tb-space-2, 8px);
}
.wm-right {
  margin-left: auto;
}
.wm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--tb-h-lg, 30px);
  padding: 0 var(--tb-space-3, 11px);
  border: 1px solid var(--tb-line, #e3e6ea);
  border-radius: var(--tb-radius-md, 6px);
  background: var(--tb-surface-sunken, #eef0f3);
  color: var(--tb-ink-1, #1b1f24);
  font-size: var(--tb-fs-body, 13px);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    transform 120ms ease;
}
.wm-btn:active {
  transform: scale(0.98);
}
.wm-btn:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
}
.wm-btn-primary {
  background: var(--tb-accent, #2f6fed);
  border-color: var(--tb-accent, #2f6fed);
  color: var(--tb-surface-raised, #fff);
}
.wm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}
.wm-seg button {
  height: var(--tb-h-lg, 30px);
  padding: 0 10px;
  border: 1px solid var(--tb-line, #e3e6ea);
  background: var(--tb-surface-raised, #fff);
  color: var(--tb-ink-2, #4a5158);
  font-size: var(--tb-fs-secondary, 12px);
  cursor: pointer;
}
.wm-seg button:first-child {
  border-radius: var(--tb-radius-md, 6px) 0 0 6px;
}
.wm-seg button:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}
.wm-seg button.on {
  background: var(--tb-accent-soft, #eaf1ff);
  color: var(--tb-accent, #2f6fed);
  font-weight: 500;
}
.wm-range {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--tb-fs-secondary, 12px);
  color: var(--tb-ink-2, #4a5158);
}
.wm-num {
  font-variant-numeric: tabular-nums;
  color: var(--tb-ink-3, #7b848d);
  font-size: var(--tb-fs-secondary, 12px);
}
.wm-note {
  display: flex;
  align-items: center;
  gap: var(--tb-space-3, 12px);
  padding: var(--tb-space-3, 10px) var(--tb-space-3, 12px);
  border: 1px solid #d8e2f7;
  border-radius: var(--tb-radius-lg, 8px);
  background: #f2f6ff;
}
.wm-note-body strong {
  font-size: var(--tb-fs-body, 13px);
}
.wm-note-body p {
  margin-top: var(--tb-space-1, 2px);
  font-size: var(--tb-fs-secondary, 12px);
  color: var(--tb-ink-2, #4a5158);
}
.wm-track {
  width: 148px;
  height: 4px;
  margin-bottom: 6px;
  overflow: hidden;
  border-radius: 2px;
  background: #dfe6f2;
}
.wm-fill {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left;
  background: var(--tb-accent, #2f6fed);
  transition: transform 150ms linear;
}
.wm-warn,
.wm-ok {
  padding: 8px 10px;
  border-radius: var(--tb-radius-md, 6px);
  font-size: var(--tb-fs-secondary, 12px);
}
.wm-warn {
  background: #fdf6ec;
  border: 1px solid #f3d5b3;
  color: #8a5a1a;
}
.wm-ok {
  background: #effaf3;
  border: 1px solid #b7e3cc;
  color: #1c6b40;
  word-break: break-all;
}
.wm-stage {
  position: relative;
  display: flex;
  min-height: 320px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--tb-line, #e3e6ea);
  border-radius: var(--tb-radius-lg, 8px);
  background: var(--tb-surface-base, #f6f7f9);
  padding: 10px;
}
.wm-canvas {
  max-height: 62vh;
  max-width: 100%;
  border-radius: 4px;
}
.wm-canvas.brush {
  cursor: crosshair;
}
.wm-over {
  position: absolute;
  max-height: 62vh;
  max-width: calc(100% - 20px);
  border-radius: 4px;
}
.wm-empty {
  padding: 40px;
  color: var(--tb-ink-3, #7b848d);
  font-size: var(--tb-fs-secondary, 12px);
  text-align: center;
  max-width: 460px;
}
.wm-foot {
  display: flex;
  justify-content: space-between;
}
</style>
