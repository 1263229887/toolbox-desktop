<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { load, save, stampPages, tileStamp, tilePositions, placementXY, stampMatrix, readMetadata, writeMetadata } from '../pdf/ops.js'
import { openPreview, renderPage } from '../pdf/preview.js'
import ctx from '@/services/ctx'

const api = ctx
const TABS = [
  { id: 'watermark', label: '文字水印' },
  { id: 'number', label: '页码' },
  { id: 'meta', label: '元数据' },
]

const tab = ref('watermark')
const file = ref(null)
const doc = ref(null)
const busy = ref('')
const err = ref('')
const note = ref('')

const wm = ref({ text: '内部资料', size: 28, color: '#9aa3ad', opacity: 0.28, placement: 'bottom-right', tile: false, angle: 30, gap: 90 })
const num = ref({ format: '第 {n} 页 / 共 {total} 页', size: 12, color: '#4a5158', placement: 'bottom-center', start: 1, skipFirst: false })
const meta = ref({ title: '', author: '', subject: '', keywords: '', creator: '', producer: '' })

const PLACEMENTS = [
  ['top-left', '上左'], ['top-center', '上中'], ['top-right', '上右'],
  ['center-left', '中左'], ['center', '正中'], ['center-right', '中右'],
  ['bottom-left', '下左'], ['bottom-center', '下中'], ['bottom-right', '下右'],
]

const pages = computed(() => (doc.value ? doc.value.getPageCount() : 0))
const pageLabel = computed(() => `${pages.value} 页`)

/* ---------- 预览 ---------- */
const stageBox = ref(null)
const stage = ref(null)
const previewDoc = ref(null)
const previewErr = ref('')
const pageIndex = ref(0)
let drawTimer = null
let drawing = false
let queued = false

async function openPreviewQuietly(bytes) {
  previewErr.value = ''
  try {
    previewDoc.value = await openPreview(bytes)
  } catch (e) {
    previewDoc.value = null
    previewErr.value = e.message
  }
  await nextTick()
  draw()
}

/** 与导出共用：把当前参数换算成「贴在页上的那几张图」，坐标全部用 pdf-lib 的未旋转页面尺寸 */
async function overlaySpec(libPage, index, total) {
  if (tab.value === 'watermark') {
    const text = wm.value.text.trim()
    if (!text) return null
    const ov = await renderTextPng(text, wm.value)
    const pw = libPage.getWidth()
    const ph = libPage.getHeight()
    const rects = wm.value.tile
      ? tilePositions(pw, ph, ov.width, ov.height, wm.value.gap, wm.value.gap, wm.value.angle).map((p) => ({ ...p, w: ov.width, h: ov.height, angle: wm.value.angle }))
      : [{ ...placementXY(wm.value.placement, pw, ph, ov.width, ov.height), w: ov.width, h: ov.height }]
    return { src: ov.canvas, rects, opacity: wm.value.opacity }
  }
  if (tab.value === 'number') {
    if (num.value.skipFirst && index === 0) return null
    const text = num.value.format.replace('{n}', String(index + num.value.start)).replace('{total}', String(total))
    const ov = await renderTextPng(text, num.value)
    const { x, y } = placementXY(num.value.placement, libPage.getWidth(), libPage.getHeight(), ov.width, ov.height, 14)
    return { src: ov.canvas, rects: [{ x, y, w: ov.width, h: ov.height }], opacity: 1 }
  }
  return null
}

async function draw() {
  if (!previewDoc.value || !stage.value) return
  // 正在画时不丢弃这次请求：拖动滑块期间的最后一次参数必须落到屏幕上
  if (drawing) { queued = true; return }
  drawing = true
  try {
    const page = await previewDoc.value.getPage(pageIndex.value + 1)
    const width = Math.max(280, (stageBox.value?.clientWidth || 440) - 18)
    await renderPage(page, stage.value, width, async (g, transform) => {
      const spec = await overlaySpec(doc.value.getPage(pageIndex.value), pageIndex.value, pages.value)
      if (!spec) return
      g.save()
      g.globalAlpha = spec.opacity
      for (const r of spec.rects) {
        const m = stampMatrix(transform, r)
        g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
        g.drawImage(spec.src, 0, 0, 1, 1)
      }
      g.restore()
    })
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') previewErr.value = e.message
  } finally {
    drawing = false
    if (queued) {
      queued = false
      draw()
    }
  }
}

/** 拖动滑块时每帧重渲染会排队，收敛到一次 */
function scheduleDraw() {
  clearTimeout(drawTimer)
  drawTimer = setTimeout(draw, 90)
}

watch([tab, pageIndex, wm, num], scheduleDraw, { deep: true })

function step(delta) {
  const next = Math.min(pages.value - 1, Math.max(0, pageIndex.value + delta))
  if (next !== pageIndex.value) pageIndex.value = next
}

async function pick() {
  const paths = await api.call('dialog:pickFiles', { multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (!paths?.length) return
  const [f] = await api.call('files:read', { filePaths: paths })
  try {
    doc.value = await load(f.data)
    file.value = { name: f.name, bytes: f.data }
    meta.value = readMetadata(doc.value)
    pageIndex.value = 0
    err.value = ''
    note.value = ''
  } catch (e) {
    err.value = `无法打开：${e.message}（加密 PDF 暂不支持）`
    return
  }
  await openPreviewQuietly(f.data)
}

/**
 * 中文交给 canvas 渲染成带透明通道的 PNG 再贴进 PDF。
 * 不嵌字体：pdf-lib 的 embedFont 不处理 .ttc 字体集合（Windows 中文字体基本都是集合），
 * 打包字体又是几 MB 起步还牵扯授权。3x 超采样保证打印不糊。
 * canvas 一并返回，预览时直接拿它当图源，省掉一次解码。
 */
async function renderTextPng(text, { size, color }) {
  const scale = 3
  const pad = Math.round(size * 0.35)
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = `${size * scale}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
  const w = Math.ceil(probe.measureText(text).width) + pad * 2
  const h = Math.ceil(size * scale) + pad * 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  g.font = probe.font
  g.fillStyle = color
  g.textBaseline = 'middle'
  g.fillText(text, pad, h / 2)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, canvas, width: w / scale, height: h / scale }
}

async function run() {
  if (!doc.value || busy.value) return
  busy.value = '处理中'
  err.value = ''
  note.value = ''
  try {
    // 每次都从原始字节重新载入，避免重复点「应用」把水印叠层累加
    const fresh = await load(file.value.bytes)
    const all = fresh.getPages().map((_p, i) => i)
    let count = 0
    if (tab.value === 'watermark') {
      const text = wm.value.text.trim()
      if (!text) throw new Error('水印文字为空')
      const ov = await renderTextPng(text, wm.value)
      if (wm.value.tile) {
        count = await tileStamp(fresh, all, { ...ov, gapX: wm.value.gap, gapY: wm.value.gap, angle: wm.value.angle, opacity: wm.value.opacity })
      } else {
        count = await stampPages(fresh, all, (page) => {
          const { x, y } = placementXY(wm.value.placement, page.getWidth(), page.getHeight(), ov.width, ov.height)
          return { ...ov, x, y, opacity: wm.value.opacity }
        })
      }
    } else if (tab.value === 'number') {
      const total = fresh.getPageCount()
      const targets = all.filter((i) => !(num.value.skipFirst && i === 0))
      count = await stampPages(fresh, targets, async (page, i) => {
        const text = num.value.format.replace('{n}', String(i + num.value.start)).replace('{total}', String(total))
        const ov = await renderTextPng(text, num.value)
        const { x, y } = placementXY(num.value.placement, page.getWidth(), page.getHeight(), ov.width, ov.height, 14)
        return { ...ov, x, y, opacity: 1 }
      })
    } else {
      writeMetadata(fresh, meta.value)
      count = 1
    }
    const out = await save(fresh)
    const name = file.value.name.replace(/\.pdf$/i, '') + (tab.value === 'watermark' ? '-已加水印.pdf' : tab.value === 'number' ? '-已加页码.pdf' : '-已改属性.pdf')
    const r = await api.call('files:save', { name, data: out })
    if (!r.canceled) note.value = `已处理 ${count} 页 → ${r.path}`
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="stack max-w-[1180px]">
    <div class="row">
      <button class="btn-primary" @click="pick"><span class="i-lucide-file-input size-4" />选择 PDF</button>
      <span v-if="file" class="muted truncate">{{ file.name }} · {{ pageLabel }}</span>
      <span v-else class="muted">加密 PDF 暂不支持</span>
    </div>

    <div v-if="file" class="inline-flex rounded-md border border-surface-line-strong bg-surface-raised p-0.5">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="h-7 rounded px-3 text-13px transition-colors duration-[var(--m-micro)]"
        :class="tab === t.id ? 'bg-accent text-white font-500' : 'text-ink-2 hover:bg-surface-sunken'"
        @click="tab = t.id; err = ''; note = ''"
      >{{ t.label }}</button>
    </div>

    <div v-if="file" class="grid min-w-0 gap-4 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
      <div class="card stack p-4">
        <template v-if="tab === 'watermark'">
          <label class="stack gap-1">
            <span class="label">水印文字</span>
            <input v-model="wm.text" class="field" data-selectable />
          </label>
          <label class="stack gap-1">
            <span class="label">字号 {{ wm.size }}</span>
            <input v-model.number="wm.size" type="range" min="12" max="96" />
          </label>
          <label class="stack gap-1">
            <span class="label">不透明度 {{ Math.round(wm.opacity * 100) }}%</span>
            <input v-model.number="wm.opacity" type="range" min="0.06" max="1" step="0.02" />
          </label>
          <label class="stack gap-1">
            <span class="label">颜色</span>
            <input v-model="wm.color" type="color" class="h-8 w-full cursor-pointer rounded border border-surface-line-strong bg-surface-raised" />
          </label>
          <label class="stack gap-1">
            <span class="label">位置</span>
            <select v-model="wm.placement" class="field" :disabled="wm.tile">
              <option v-for="[v, l] in PLACEMENTS" :key="v" :value="v">{{ l }}</option>
            </select>
          </label>
          <label class="row">
            <input v-model="wm.tile" type="checkbox" />
            <span class="text-13px">整页平铺（防裁切）</span>
          </label>
          <template v-if="wm.tile">
            <label class="stack gap-1">
              <span class="label">平铺间距 {{ wm.gap }}</span>
              <input v-model.number="wm.gap" type="range" min="20" max="260" step="10" />
            </label>
            <label class="stack gap-1">
              <span class="label">倾斜角度 {{ wm.angle }}°</span>
              <input v-model.number="wm.angle" type="range" min="-60" max="60" step="5" />
              <span class="caption">正值往右上斜，负值往右下斜</span>
            </label>
          </template>
        </template>

        <template v-else-if="tab === 'number'">
          <label class="stack gap-1">
            <span class="label">页码格式（<span class="font-mono">{n}</span> 当前页、<span class="font-mono">{total}</span> 总页数）</span>
            <select class="field" @change="num.format = $event.target.value">
              <option value="第 {n} 页 / 共 {total} 页">第 1 页 / 共 N 页</option>
              <option value="{n}">1</option>
              <option value="{n} / {total}">1 / N</option>
              <option value="- {n} -">- 1 -</option>
            </select>
          </label>
          <label class="stack gap-1">
            <span class="label">位置</span>
            <select v-model="num.placement" class="field">
              <option v-for="[v, l] in PLACEMENTS" :key="v" :value="v">{{ l }}</option>
            </select>
          </label>
          <label class="stack gap-1">
            <span class="label">字号 {{ num.size }}</span>
            <input v-model.number="num.size" type="range" min="8" max="32" />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="stack gap-1">
              <span class="label">起始页码</span>
              <input v-model.number="num.start" type="number" min="0" class="field" />
            </label>
            <label class="stack gap-1">
              <span class="label">颜色</span>
              <input v-model="num.color" type="color" class="h-8 w-full cursor-pointer rounded border border-surface-line-strong bg-surface-raised" />
            </label>
          </div>
          <label class="row">
            <input v-model="num.skipFirst" type="checkbox" />
            <span class="text-13px">首页不编页码（封面）</span>
          </label>
        </template>

        <template v-else>
          <label v-for="f in [['title', '标题'], ['author', '作者'], ['subject', '主题'], ['keywords', '关键词'], ['creator', '创建程序'], ['producer', '生成程序']]" :key="f[0]" class="stack gap-1">
            <span class="label">{{ f[1] }}</span>
            <input v-model="meta[f[0]]" class="field" data-selectable />
          </label>
          <p class="muted">清空某个字段再应用，即从 PDF 属性里去掉它。这些字段就是资源管理器「详细信息」里看到的内容。</p>
        </template>

        <p v-if="err" class="rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">{{ err }}</p>
        <p v-if="note" class="rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px break-all text-#1c6b40">{{ note }}</p>

        <button class="btn-primary self-start" :disabled="!!busy" @click="run">
          <span v-if="busy" class="i-lucide-loader-2 size-4 animate-spin" />
          {{ busy || (tab === 'meta' ? '保存属性' : '应用并另存为') }}
        </button>
        <p v-if="tab !== 'meta'" class="muted">每次都从原文件重新处理，重复点不会把水印叠成两层；结果另存为新文件，不改动原件。</p>
      </div>

      <section class="card min-w-0 p-3">
        <div class="row justify-between pb-2">
          <span class="label">{{ tab === 'meta' ? '页面预览' : '实时预览' }}</span>
          <div class="row gap-1">
            <button class="btn-ghost h-6 px-1.5" :disabled="pageIndex === 0" @click="step(-1)"><span class="i-lucide-chevron-left size-3.5" /></button>
            <span class="caption tabular w-16 text-center">{{ pageIndex + 1 }} / {{ pages }}</span>
            <button class="btn-ghost h-6 px-1.5" :disabled="pageIndex >= pages - 1" @click="step(1)"><span class="i-lucide-chevron-right size-3.5" /></button>
          </div>
        </div>
        <div ref="stageBox" class="max-h-[calc(100vh-230px)] min-h-[320px] overflow-auto rounded border border-surface-line bg-surface-sunken p-2">
          <canvas v-show="!previewErr" ref="stage" class="block bg-white shadow-sm" />
          <p v-if="previewErr" class="muted px-1 py-6 text-center">预览不可用：{{ previewErr }}</p>
        </div>
        <p class="caption mt-2 px-1">预览按屏幕宽度等比缩放，水印在 PDF 里的实际尺寸以字号（pt）计；平铺时超出页面边缘的部分会被页面裁掉。</p>
      </section>
    </div>
  </div>
</template>
