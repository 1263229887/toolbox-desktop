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
// 一键形态：默认自动出结果，微调面板收起；applied 决定画布显示修复后还是原图
const applied = ref(false)
const advanced = ref(false)

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
  // 先亮进度条：网络慢时若等 total 才画，会像「点了没反应」
  dl.value = { percent: 0, received: 0, total: 0 }
  try {
    offProgress = api.on('wm:progress', (p) => {
      if (p.total) dl.value = { percent: Math.round((p.received / p.total) * 100), received: p.received, total: p.total }
      else if (p.received) dl.value = { ...dl.value, received: p.received }
    })
    await api.call('wm:prepare', { id: 'migan' })
    await refreshModel()
    if (img.value) await detect()
  } catch (e) {
    err.value = e.message
  } finally {
    offProgress?.()
    offProgress = null
    busy.value = ''
    if (!ready.value) dl.value = null
  }
}

async function detect() {
  if (!img.value || !ready.value) return
  busy.value = '识别中'
  err.value = ''
  try {
    const list = await api.call('wm:detect', toRawImage())
    // 实测口径（tools/bench/detect-recall.mjs，7 张真样本）：
    // 全取 = 命中 6/7 但误伤 6 处；只取分数最高 1 个 = 命中 6/7、误伤 0。
    // 所以默认只自动应用第一候选，其余留在「微调」里让用户点选。
    boxes.value = list.map((b, k) => ({ ...b, on: k === 0 }))
    if (!boxes.value.length) {
      err.value = '没找到疑似水印，展开「微调」用画笔涂一下要修的区域'
      advanced.value = true
      draw()
      return
    }
    draw()
    // 一键：检测到就直接修，不满意再点「微调」
    await run()
    if (boxes.value.length > 1) err.value = `另有 ${boxes.value.length - 1} 处疑似水印未处理，可在「微调」里勾选`
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
  // 一键之后画布默认显示修复结果；按住对比才回原图；撤销后也回原图
  const showing = compare.value || !applied.value ? rgb : img.value.resultRgb || rgb
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    data.data[j] = showing[i * 3]
    data.data[j + 1] = showing[i * 3 + 1]
    data.data[j + 2] = showing[i * 3 + 2]
    data.data[j + 3] = 255
  }
  g.putImageData(data, 0, 0)
  const mask = buildMask()
  // 结果已应用时不再糊红罩子，只留框线：用户要看的是修完的图，不是选区
  if (!applied.value || compare.value) {
    g.fillStyle = 'rgba(255,64,96,0.42)'
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) g.fillRect(x, y, 1, 1)
  }
  g.lineWidth = Math.max(1, w / 600)
  g.strokeStyle = 'rgba(255,255,255,0.85)'
  for (const b of boxes.value) {
    if (!b.on) continue
    g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
  }
}

/** 撤销不是删除结果：保留 resultRgb，用户还能点「恢复」切回来 */
function undo() {
  applied.value = false
  compare.value = false
  advanced.value = true
  draw()
}

function redo() {
  if (!img.value?.resultRgb) return
  applied.value = true
  draw()
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
    applied.value = true
    draw()
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}

function oneClick() {
  if (!img.value) return open()
  return detect()
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
      <!-- 一键：检测完直接修，不满意再展开微调 -->
      <button class="wm-btn" :disabled="!img || !ready || !!busy" @click="oneClick">
        <span v-if="busy" class="wm-spin" />{{ busy || '一键去水印' }}
      </button>
      <button class="wm-btn" :disabled="!img" @click="advanced = !advanced">{{ advanced ? '收起微调' : '微调' }}</button>
      <div class="wm-right">
        <button v-if="applied" class="wm-btn" @pointerdown="compare = true; draw()" @pointerup="compare = false; draw()" @pointerleave="compare && (compare = false, draw())">按住看原图</button>
        <button v-if="applied" class="wm-btn" @click="undo">撤销</button>
        <button v-else-if="img?.resultRgb" class="wm-btn wm-btn-primary" @click="redo">恢复结果</button>
        <button class="wm-btn wm-btn-primary" :disabled="!img?.result" @click="save">保存 PNG</button>
      </div>
    </div>

    <div v-show="advanced && img" class="wm-bar wm-adv">
      <span class="wm-adv-label">微调</span>
      <div class="wm-seg">
        <button :class="{ on: mode === 'box' }" @click="mode = 'box'">点选框</button>
        <button :class="{ on: mode === 'brush' }" @click="mode = 'brush'">画笔补</button>
      </div>
      <label class="wm-range">
        笔刷
        <input v-model.number="brush" type="range" min="6" max="120" />
        <span class="wm-num">{{ brush }}</span>
      </label>
      <button class="wm-btn" @click="clearBrush">擦掉笔迹</button>
      <button class="wm-btn" :disabled="!ready || !!busy" @click="detect">重新识别</button>
      <button class="wm-btn wm-btn-primary" :disabled="!hasMask || !!busy" @click="run">按选区修复</button>
    </div>

    <p v-if="applied" class="wm-done">
      已自动处理 {{ boxes.filter((b) => b.on).length }} 处
      <span class="wm-done-hint">不满意就点「微调」改选区，或「撤销」回到原图</span>
    </p>

    <div v-if="!ready" class="wm-note">
      <div class="wm-note-body">
        <strong>需要下载修复模型（约 31 MB）</strong>
        <p>MI-GAN 权重与运行时按需下载到本机，之后离线可用；不进安装包。模型只在你自己的电脑上运行，图片不会上传。</p>
      </div>
      <div>
        <div v-if="busy === '下载模型'" class="wm-track"><span class="wm-fill" :style="{ transform: `scaleX(${(dl?.percent || 0) / 100})` }" /></div>
        <button class="wm-btn wm-btn-primary" :disabled="!!busy" @click="downloadModel">
          {{ busy === '下载模型' ? (dl?.total ? `下载中 ${dl.percent}%` : '连接中…') : '下载模型' }}
        </button>
      </div>
    </div>

    <p v-if="err" class="wm-warn">{{ err }}</p>
    <p v-if="savedPath" class="wm-ok">{{ savedPath }}</p>

    <div class="wm-stage">
      <canvas v-if="img" ref="stage" class="wm-canvas" :class="{ brush: mode === 'brush' }" @pointerdown="onDown" @pointermove="onMove" @pointerup="painting = false" @pointerleave="painting = false" />
      <p v-else-if="!img" class="wm-empty">打开一张图片即可，程序会自动找出水印并直接修复。识别不准时再展开「微调」手动框或涂。</p>
    </div>

    <div class="wm-foot">
      <span>{{ img ? `${img.w}×${img.h} · 候选 ${boxes.length} · 已选 ${boxes.filter((b) => b.on).length}` : '未选择图片' }}</span>
      <span class="wm-num">修复区 {{ (maskInfo.count / 1000).toFixed(0) }},000 px</span>
    </div>
  </div>
</template>

<!-- 样式在 src/style.css，由 index.js 注入；scoped 的 data-v 在独立 ESM 构建里对不上宿主 DOM -->

