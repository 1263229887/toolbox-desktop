<script setup>
import { computed, ref } from 'vue'
import { PDFDocument } from 'pdf-lib'
import ctx from '@/services/ctx'

const props = defineProps({ ctx: { type: Object, default: null } })
const api = props.ctx || ctx

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
}
const MM_TO_PT = 2.834645

const files = ref([]) // { path, name, url, w, h, bytes, type }
const options = ref({ pageSize: 'A4', orientation: 'auto', margin: 10, whiteBg: true })
const busy = ref('')
const error = ref('')
const done = ref(null)

const canGenerate = computed(() => files.value.length > 0 && !busy.value)

async function pick() {
  const paths = await api.call('dialog:pickFiles', { multiple: true })
  if (!paths?.length) return
  await addFiles(paths)
}

async function addFiles(paths) {
  busy.value = '读取中'
  error.value = ''
  try {
    const loaded = await api.call('files:read', { filePaths: paths })
    for (const f of loaded) {
      const meta = await probe(f.data, f.mime)
      if (!meta) {
        error.value = `跳过无法解码的文件：${f.name}`
        continue
      }
      files.value.push({ path: f.path, name: f.name, bytes: f.data, w: meta.w, h: meta.h, url: meta.url, kind: meta.kind })
    }
  } finally {
    busy.value = ''
  }
}

/** 用 canvas 统一解码，顺带解决 webp/gif 不能直接塞进 PDF 的问题 */
async function probe(bytes, mime) {
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode'))
      el.src = blobUrl
    })
    return { w: img.naturalWidth, h: img.naturalHeight, url: blobUrl, kind: kindOf(mime) }
  } catch {
    URL.revokeObjectURL(blobUrl)
    return null
  }
}

function kindOf(mime) {
  // pdf-lib 只认 JPEG/PNG 两种内嵌格式，其余（webp/gif/heic）统一转 JPEG
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  return 'convert'
}

async function toJpegBytes(item) {
  const c = document.createElement('canvas')
  c.width = item.w
  c.height = item.h
  const g = c.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(await loadEl(item.url), 0, 0)
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92))
  return new Uint8Array(await blob.arrayBuffer())
}

function loadEl(url) {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = reject
    el.src = url
  })
}

function move(index, delta) {
  const next = [...files.value]
  const to = index + delta
  if (to < 0 || to >= next.length) return
  ;[next[index], next[to]] = [next[to], next[index]]
  files.value = next
}

function remove(index) {
  URL.revokeObjectURL(files.value[index].url)
  files.value.splice(index, 1)
}

function clearAll() {
  for (const f of files.value) URL.revokeObjectURL(f.url)
  files.value = []
}

async function generate() {
  if (!canGenerate.value) return
  busy.value = '合成中'
  error.value = ''
  done.value = null
  try {
    const doc = await PDFDocument.create()
    const margin = options.value.margin * MM_TO_PT
    for (const item of files.value) {
      const payload = item.kind === 'convert' ? await toJpegBytes(item) : item.bytes
      const embedded = item.kind === 'png' ? await doc.embedPng(payload) : await doc.embedJpg(payload)
      const base = PAGE_SIZES[options.value.pageSize]
      const useOriginal = !base
      const portrait = useOriginal ? [item.w, item.h] : base
      const landscape = useOriginal ? [item.w, item.h] : [base[1], base[0]]
      const horizontal = options.value.orientation === 'landscape' || (options.value.orientation === 'auto' && item.w > item.h)
      const [pw, ph] = useOriginal ? portrait : horizontal ? landscape : portrait
      const page = doc.addPage([pw, ph])
      if (options.value.whiteBg) page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: [1, 1, 1] })
      const availW = Math.max(1, pw - margin * 2)
      const availH = Math.max(1, ph - margin * 2)
      const scale = Math.min(availW / embedded.width, availH / embedded.height)
      const w = embedded.width * scale
      const h = embedded.height * scale
      page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
    }
    const bytes = await doc.save()
    const first = files.value[0].name.replace(/\.[^.]+$/, '')
    const r = await api.call('files:save', { name: `${first || '图片'}.pdf`, data: bytes })
    if (!r.canceled) done.value = r
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = ''
  }
}

async function onDrop(e) {
  const paths = [...e.dataTransfer.files].map((f) => window.toolbox.pathFor?.(f)).filter(Boolean)
  if (paths.length) await addFiles(paths)
}
</script>

<template>
  <div class="grid grid-cols-[minmax(0,1fr)_260px] gap-4">
    <section class="min-w-0">
      <div
        class="mb-3 flex items-center gap-2"
        @dragover.prevent
        @drop.prevent="onDrop"
      >
        <button class="btn-primary" @click="pick"><span class="i-lucide-image-plus size-4" />添加图片</button>
        <span class="muted">可直接拖进这一栏 · 已选 {{ files.length }} 张</span>
        <button class="btn-ghost ml-auto" :disabled="!files.length" @click="clearAll">清空</button>
      </div>

      <div v-if="error" class="mb-3 rounded-md border border-#f3d5b3 bg-#fdf6ec px-3 py-2 text-12px text-#8a5a1a">{{ error }}</div>

      <ul v-if="files.length" class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        <li v-for="(item, index) in files" :key="item.path" class="card group relative overflow-hidden">
          <img :src="item.url" class="h-28 w-full bg-surface-sunken object-contain" :alt="item.name" />
          <div class="flex items-center justify-between gap-1 border-t border-surface-line px-1.5 py-1">
            <span class="truncate text-11px text-ink-3">{{ index + 1 }}. {{ item.name }}</span>
            <span class="flex flex-none items-center gap-0.5">
              <button class="btn-ghost h-5 px-1" :disabled="index === 0" @click="move(index, -1)"><span class="i-lucide-arrow-up size-3" /></button>
              <button class="btn-ghost h-5 px-1" :disabled="index === files.length - 1" @click="move(index, 1)"><span class="i-lucide-arrow-down size-3" /></button>
              <button class="btn-ghost h-5 px-1 text-danger" @click="remove(index)"><span class="i-lucide-x size-3" /></button>
            </span>
          </div>
        </li>
      </ul>
      <p v-else class="muted rounded-md border border-dashed border-surface-line-strong py-16 text-center">还没有图片</p>
    </section>

    <aside class="flex-none self-start">
      <div class="card p-3">
        <div class="label mb-3">输出设置</div>
        <label class="mb-2.5 block">
          <span class="label mb-1 block">纸张</span>
          <select v-model="options.pageSize" class="field w-full">
            <option>A4</option>
            <option>A5</option>
            <option>Letter</option>
            <option value="">按图片尺寸</option>
          </select>
        </label>
        <label class="mb-2.5 block">
          <span class="label mb-1 block">方向</span>
          <select v-model="options.orientation" class="field w-full" :disabled="!options.pageSize">
            <option value="auto">自动（跟随图片）</option>
            <option value="portrait">纵向</option>
            <option value="landscape">横向</option>
          </select>
        </label>
        <label class="mb-2.5 block">
          <span class="label mb-1 block">页边距 {{ options.margin }} mm</span>
          <input v-model.number="options.margin" type="range" min="0" max="30" step="1" class="w-full" :disabled="!options.pageSize" />
        </label>
        <label class="flex items-center gap-2 text-12px">
          <input v-model="options.whiteBg" type="checkbox" />
          背景填白
        </label>
      </div>

      <button class="btn-primary mt-3 h-9 w-full" :disabled="!canGenerate" @click="generate">
        <span v-if="busy" class="i-lucide-loader-2 size-4 animate-spin" />
        {{ busy || '生成 PDF' }}
      </button>

      <div v-if="done" class="mt-3 rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px text-#1c6b40">
        <div class="data-selectable truncate">{{ done.path }}</div>
        <div class="tabular mt-1">{{ (done.size / 1048576).toFixed(2) }} MB</div>
        <button class="btn-ghost mt-1 h-6 px-2 text-12px" @click="api.call('shell:showItemInFolder', { target: done.path })">在文件夹中显示</button>
      </div>
    </aside>
  </div>
</template>
