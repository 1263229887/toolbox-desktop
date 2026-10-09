<script setup>
import { computed, ref } from 'vue'
import { PDFDocument } from 'pdf-lib'
import { load, replaceJpegImages, save } from '../pdf/ops.js'
import ctx from '@/services/ctx'

const api = ctx

const file = ref(null) // { path, name, bytes, size }
const report = ref(null) // { before, after, images, skipped, pages }
const busy = ref('')
const err = ref('')
const opts = ref({ quality: 0.72, maxSide: 1600 })
const saved = ref('')

const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB')
const savedPct = computed(() => (report.value ? Math.round((1 - report.value.after / report.value.before) * 100) : 0))

async function pick() {
  const paths = await api.call('dialog:pickFiles', { multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (!paths?.length) return
  const [f] = await api.call('files:read', { filePaths: paths })
  file.value = { path: f.path, name: f.name, bytes: f.data, size: f.data.length }
  report.value = null
  saved.value = ''
  err.value = ''
}

async function run() {
  if (!file.value || busy.value) return
  busy.value = '压缩中'
  err.value = ''
  try {
    const doc = await load(file.value.bytes)
    const { images, skipped, shrunk } = await replaceJpegImages(doc, (bytes) => recompressJpeg(bytes, opts.value.quality, opts.value.maxSide))
    const out = await save(doc)
    report.value = { before: file.value.size, after: out.length, images, skipped, shrunk, pages: doc.getPageCount(), bytes: out }
    if (!images) err.value = '这个 PDF 里没有可压缩的 JPEG 图像（可能是纯文字或用了其他编码），体积基本不会变。'
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}

async function recompressJpeg(bytes, quality, maxSide) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode'))
      el.src = url
    })
    const scale = maxSide ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1
    if (scale >= 1 && quality >= 0.99) return null
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const g = canvas.getContext('2d')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  } catch {
    return null // 解码不了（可能是 CMYK 或渐进式异常），保留原样
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function saveOut() {
  if (!report.value) return
  const name = file.value.name.replace(/\.pdf$/i, '') + `-压缩.pdf`
  const r = await api.call('files:save', { name, data: report.value.bytes })
  if (!r.canceled) saved.value = r.path
}
</script>

<template>
  <div class="stack max-w-[560px]">
    <div class="row">
      <button class="btn-primary" @click="pick"><span class="i-lucide-file-input size-4" />选择 PDF</button>
      <span v-if="file" class="muted truncate">{{ file.name }} · {{ kb(file.size) }}</span>
      <span v-else class="muted">扫描件、截图拼的 PDF 效果最好</span>
    </div>

    <div class="card p-4 stack">
      <label class="stack gap-1">
        <span class="label">图像质量 {{ Math.round(opts.quality * 100) }}</span>
        <input v-model.number="opts.quality" type="range" min="0.4" max="0.95" step="0.02" />
      </label>
      <label class="stack gap-1">
        <span class="label">图像最长边 {{ opts.maxSide || '不缩放' }}</span>
        <input v-model.number="opts.maxSide" type="range" min="0" max="3000" step="100" />
      </label>
      <p class="muted">只重压 PDF 内嵌的 JPEG 图像，文字、矢量与页面结构原样保留，不会变成"整页截图"。</p>
    </div>

    <div class="row">
      <button class="btn-primary" :disabled="!file || !!busy" @click="run">
        <span v-if="busy" class="i-lucide-loader-2 size-4 animate-spin" />{{ busy || '开始压缩' }}
      </button>
      <button v-if="report" class="btn-plain" @click="saveOut">保存结果</button>
    </div>

    <p v-if="err" class="rounded-md border border-#f3d5b3 bg-#fdf6ec px-3 py-2 text-12px text-#8a5a1a">{{ err }}</p>

    <div v-if="report" class="card p-4 stack">
      <div class="row justify-between">
        <span class="title tabular">{{ kb(report.before) }} → {{ kb(report.after) }}</span>
        <span class="tabular text-16px font-600 text-ok">-{{ savedPct }}%</span>
      </div>
      <div class="h-1 overflow-hidden rounded bg-surface-sunken">
        <span class="block h-full w-full origin-left rounded bg-ok transition-transform duration-[var(--m-standard)]" :style="{ transform: `scaleX(${report.after / report.before})` }" />
      </div>
      <p class="muted tabular">
        重压 {{ report.images }} 张图像（省 {{ kb(report.shrunk) }}）· 未变小或无法解码 {{ report.skipped }} 张 · 共 {{ report.pages }} 页
      </p>
      <p v-if="!report.images" class="muted">这类 PDF 的体积通常来自字体或矢量数据，本工具不会动它们。</p>
    </div>

    <p v-if="saved" class="muted break-all data-selectable">已保存：{{ saved }}</p>
  </div>
</template>
