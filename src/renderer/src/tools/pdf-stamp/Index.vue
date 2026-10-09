<script setup>
import { computed, ref } from 'vue'
import { load, save, stampPages, tileStamp, placementXY, readMetadata, writeMetadata } from '../pdf/ops.js'
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

const wm = ref({ text: '内部资料', size: 28, color: '#9aa3ad', opacity: 0.28, placement: 'bottom-right', tile: false, angle: -30, gap: 90 })
const num = ref({ format: '第 {n} 页 / 共 {total} 页', size: 12, color: '#4a5158', placement: 'bottom-center', start: 1, skipFirst: false })
const meta = ref({ title: '', author: '', subject: '', keywords: '', creator: '', producer: '' })
const overlayPreview = ref('')

const PLACEMENTS = [
  ['top-left', '上左'], ['top-center', '上中'], ['top-right', '上右'],
  ['center-left', '中左'], ['center', '正中'], ['center-right', '中右'],
  ['bottom-left', '下左'], ['bottom-center', '下中'], ['bottom-right', '下右'],
]

const pages = computed(() => (doc.value ? doc.value.getPageCount() : 0))

async function pick() {
  const paths = await api.call('dialog:pickFiles', { multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (!paths?.length) return
  const [f] = await api.call('files:read', { filePaths: paths })
  try {
    doc.value = await load(f.data)
    file.value = { name: f.name, bytes: f.data }
    meta.value = readMetadata(doc.value)
    err.value = ''
    note.value = ''
  } catch (e) {
    err.value = `无法打开：${e.message}（加密 PDF 暂不支持）`
  }
}

/**
 * 中文交给 canvas 渲染成带透明通道的 PNG 再贴进 PDF。
 * 不嵌字体：pdf-lib 的 embedFont 不处理 .ttc 字体集合（Windows 中文字体基本都是集合），
 * 打包字体又是几 MB 起步还牵扯授权。3x 超采样保证打印不糊。
 */
async function renderTextPng(text, { size, color, opacity }) {
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
  g.globalAlpha = opacity
  g.textBaseline = 'middle'
  g.fillText(text, pad, h / 2)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, width: w / scale, height: h / scale }
}

async function previewOverlay() {
  if (tab.value !== 'watermark') return
  try {
    const ov = await renderTextPng(wm.value.text || '水印', { size: wm.value.size, color: wm.value.color, opacity: 1 })
    const url = URL.createObjectURL(new Blob([ov.bytes], { type: 'image/png' }))
    if (overlayPreview.value) URL.revokeObjectURL(overlayPreview.value)
    overlayPreview.value = url
  } catch {
    overlayPreview.value = ''
  }
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
      const ov = await renderTextPng(text, { size: wm.value.size, color: wm.value.color, opacity: 1 })
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
        const ov = await renderTextPng(text, { size: num.value.size, color: num.value.color, opacity: 1 })
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
  <div class="stack max-w-[720px]">
    <div class="row">
      <button class="btn-primary" @click="pick"><span class="i-lucide-file-input size-4" />选择 PDF</button>
      <span v-if="file" class="muted truncate">{{ file.name }} · {{ pages }} 页</span>
      <span v-else class="muted">加密 PDF 暂不支持</span>
    </div>

    <div v-if="file" class="inline-flex rounded-md border border-surface-line-strong bg-surface-raised p-0.5">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="h-7 rounded px-3 text-13px transition-colors duration-[var(--m-micro)]"
        :class="tab === t.id ? 'bg-accent text-white font-500' : 'text-ink-2 hover:bg-surface-sunken'"
        @click="tab = t.id; err = ''; note = ''; previewOverlay()"
      >{{ t.label }}</button>
    </div>

    <div v-if="file" class="card p-4 stack">
      <template v-if="tab === 'watermark'">
        <div class="grid grid-cols-2 gap-3">
          <label class="stack gap-1">
            <span class="label">水印文字</span>
            <input v-model="wm.text" class="field" data-selectable @input="previewOverlay" />
          </label>
          <label class="stack gap-1">
            <span class="label">字号 {{ wm.size }}</span>
            <input v-model.number="wm.size" type="range" min="12" max="96" @change="previewOverlay" />
          </label>
          <label class="stack gap-1">
            <span class="label">不透明度 {{ Math.round(wm.opacity * 100) }}%</span>
            <input v-model.number="wm.opacity" type="range" min="0.06" max="1" step="0.02" />
          </label>
          <label class="stack gap-1">
            <span class="label">颜色</span>
            <input v-model="wm.color" type="color" class="h-8 w-full cursor-pointer rounded border border-surface-line-strong bg-surface-raised" @input="previewOverlay" />
          </label>
          <label class="stack gap-1">
            <span class="label">位置</span>
            <select v-model="wm.placement" class="field" :disabled="wm.tile">
              <option v-for="[v, l] in PLACEMENTS" :key="v" :value="v">{{ l }}</option>
            </select>
          </label>
          <label class="stack gap-1">
            <span class="label">平铺间距 {{ wm.gap }}</span>
            <input v-model.number="wm.gap" type="range" min="20" max="260" step="10" :disabled="!wm.tile" />
          </label>
        </div>
        <label class="row">
          <input v-model="wm.tile" type="checkbox" />
          <span class="text-13px">整页平铺（防裁切）</span>
          <template v-if="wm.tile">
            <span class="label ml-2">倾斜角度</span>
            <input v-model.number="wm.angle" type="range" min="-60" max="0" class="w-32" />
            <span class="caption tabular">{{ wm.angle }}°</span>
          </template>
        </label>
        <div v-if="overlayPreview" class="row gap-2">
          <span class="label">水印预览</span>
          <img :src="overlayPreview" class="max-h-12 rounded border border-surface-line bg-[repeating-conic-gradient(#f2f3f5_0_25%,#fff_0_50%)] bg-[length:12px_12px]" alt="水印预览" />
        </div>
      </template>

      <template v-else-if="tab === 'number'">
        <label class="stack gap-1">
          <span class="label">页码格式（<span class="font-mono">{n}</span> 当前页、<span class="font-mono">{total}</span> 总页数）</span>
          <div class="row">
            <select class="field flex-1" @change="num.format = $event.target.value">
              <option value="第 {n} 页 / 共 {total} 页">第 1 页 / 共 N 页</option>
              <option value="{n}">1</option>
              <option value="{n} / {total}">1 / N</option>
              <option value="- {n} -">- 1 -</option>
            </select>
          </div>
        </label>
        <div class="grid grid-cols-2 gap-3">
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
        <div class="grid grid-cols-2 gap-3">
          <label v-for="f in [['title', '标题'], ['author', '作者'], ['subject', '主题'], ['keywords', '关键词'], ['creator', '创建程序'], ['producer', '生成程序']]" :key="f[0]" class="stack gap-1">
            <span class="label">{{ f[1] }}</span>
            <input v-model="meta[f[0]]" class="field" data-selectable />
          </label>
        </div>
        <p class="muted">清空某个字段再应用，即从 PDF 属性里去掉它。这些字段就是资源管理器「详细信息」里看到的内容。</p>
      </template>
    </div>

    <p v-if="err" class="rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">{{ err }}</p>
    <p v-if="note" class="rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px break-all text-#1c6b40">{{ note }}</p>

    <button v-if="file" class="btn-primary self-start" :disabled="!!busy" @click="run">
      <span v-if="busy" class="i-lucide-loader-2 size-4 animate-spin" />
      {{ busy || (tab === 'meta' ? '保存属性' : '应用并另存为') }}
    </button>
    <p v-if="file && tab !== 'meta'" class="muted">每次都从原文件重新处理，重复点不会把水印叠成两层；结果另存为新文件，不改动原件。</p>
  </div>
</template>
