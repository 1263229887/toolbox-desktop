<script setup>
import { computed, ref } from 'vue'
import { load, merge as mergeDocs, split as splitDoc, organize as organizeDoc, parseRange, save } from '../pdf/ops.js'
import { openPreview } from '../pdf/preview.js'
import PdfThumb from '../pdf/PdfThumb.vue'
import ctx from '@/services/ctx'

const api = ctx
const MODES = [
  { id: 'merge', label: '合并' },
  { id: 'split', label: '拆分' },
  { id: 'organize', label: '页面整理' },
]

const mode = ref('merge')
const files = ref([]) // { path, name, bytes, doc?, pages }
const busy = ref('')
const err = ref('')
const note = ref('')
const splitRange = ref('')
// 页面整理：当前文件的页序与旋转状态
const order = ref([])
const rotations = ref({})
// 缩略图只是辅助，打不开不影响整理本身
const previewDoc = ref(null)

const current = computed(() => files.value[0] || null)

async function pick(multiple) {
  const paths = await api.call('dialog:pickFiles', { multiple, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (!paths?.length) return
  const loaded = await api.call('files:read', { filePaths: paths })
  err.value = ''
  note.value = ''
  const list = []
  for (const f of loaded) {
    try {
      const doc = await load(f.data)
      list.push({ path: f.path, name: f.name, bytes: f.data, doc, pages: doc.getPageCount() })
    } catch (e) {
      err.value = `无法打开 ${f.name}：${e.message}`
    }
  }
  files.value = mode.value === 'merge' ? [...files.value, ...list] : list.slice(0, 1)
  if (mode.value === 'organize' && list[0]) {
    order.value = list[0].doc.getPages().map((_, i) => i)
    rotations.value = {}
    previewDoc.value = null
    try {
      previewDoc.value = await openPreview(list[0].bytes)
    } catch {
      previewDoc.value = null
    }
  }
}

function moveFile(index, delta) {
  const next = [...files.value]
  const to = index + delta
  if (to < 0 || to >= next.length) return
  ;[next[index], next[to]] = [next[to], next[index]]
  files.value = next
}

function movePage(index, delta) {
  const to = index + delta
  if (to < 0 || to >= order.value.length) return
  const next = [...order.value]
  ;[next[index], next[to]] = [next[to], next[index]]
  order.value = next
}

function rotatePage(pageIndex) {
  rotations.value[pageIndex] = ((rotations.value[pageIndex] || 0) + 90) % 360
}

function dropPage(pageIndex) {
  order.value = order.value.filter((p) => p !== pageIndex)
}

async function run() {
  busy.value = '处理中'
  err.value = ''
  note.value = ''
  try {
    if (mode.value === 'merge') await merge()
    else if (mode.value === 'split') await split()
    else await organize()
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = ''
  }
}

async function merge() {
  if (files.value.length < 2) throw new Error('至少选两个 PDF')
  const out = await mergeDocs(files.value.map((f) => f.doc))
  await saveOne(await save(out), files.value[0].name.replace(/\.pdf$/i, '') + `-合并${files.value.length}份.pdf`)
}

async function split() {
  if (!current.value) return
  const src = current.value.doc
  const targets = splitRange.value.trim() ? parseRange(splitRange.value, src.getPageCount()) : src.getPages().map((_, i) => i)
  if (!targets.length) throw new Error('页码范围没解析出有效页，例：1-3,5')
  const dir = await api.call('dialog:pickFolder', {})
  if (!dir) return
  const parts = await splitDoc(src, targets)
  const items = await Promise.all(parts.map(async (one, k) => ({ name: `${current.value.name.replace(/\.pdf$/i, '')}-第${targets[k] + 1}页.pdf`, data: await save(one) })))
  const r = await api.call('files:writeBatch', { dir, items })
  note.value = `已拆出 ${r.written.length} 个文件到 ${r.dir}`
}

async function organize() {
  if (!current.value) return
  const src = current.value.doc
  if (!order.value.length) throw new Error('没有保留任何页面')
  const out = await organizeDoc(src, order.value, rotations.value)
  const dropped = src.getPageCount() - order.value.length
  await saveOne(await save(out), current.value.name.replace(/\.pdf$/i, '') + `-已整理${dropped ? `（删${dropped}页）` : ''}.pdf`)
}

async function saveOne(data, name) {
  const r = await api.call('files:save', { name, data })
  if (!r.canceled) note.value = `已保存 ${r.path}（${(r.size / 1024).toFixed(0)} KB）`
}
</script>

<template>
  <div class="stack max-w-[680px]">
    <div class="inline-flex rounded-md border border-surface-line-strong bg-surface-raised p-0.5">
      <button
        v-for="m in MODES"
        :key="m.id"
        class="h-7 rounded px-3 text-13px transition-colors duration-[var(--m-micro)]"
        :class="mode === m.id ? 'bg-accent text-white font-500' : 'text-ink-2 hover:bg-surface-sunken'"
        @click="mode = m.id; files = []; order = []; rotations = {}; previewDoc = null; err = ''; note = ''"
      >{{ m.label }}</button>
    </div>

    <div class="row">
      <button class="btn-plain" @click="pick(mode === 'merge')">
        <span class="i-lucide-folder-open size-4" />{{ mode === 'merge' ? '添加 PDF' : '选择 PDF' }}
      </button>
      <span class="muted">{{ mode === 'merge' ? `已选 ${files.length} 个，按列表顺序合并` : current ? `${current.name} · ${current.pages} 页` : '未选择' }}</span>
    </div>

    <p v-if="err" class="rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">{{ err }}</p>
    <p v-if="note" class="rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px break-all text-#1c6b40">{{ note }}</p>

    <!-- 合并：列表排序 -->
    <ul v-if="mode === 'merge' && files.length" class="card divide-y divide-surface-line">
      <li v-for="(f, i) in files" :key="f.path" class="row justify-between px-3 py-2">
        <span class="min-w-0 flex-1 truncate text-13px">{{ i + 1 }}. {{ f.name }} <span class="muted tabular">{{ f.pages }} 页</span></span>
        <span class="row">
          <button class="btn-ghost h-6 px-1.5" :disabled="i === 0" @click="moveFile(i, -1)"><span class="i-lucide-arrow-up size-3.5" /></button>
          <button class="btn-ghost h-6 px-1.5" :disabled="i === files.length - 1" @click="moveFile(i, 1)"><span class="i-lucide-arrow-down size-3.5" /></button>
          <button class="btn-ghost h-6 px-1.5 text-danger" @click="files.splice(i, 1)"><span class="i-lucide-x size-3.5" /></button>
        </span>
      </li>
    </ul>

    <!-- 拆分：范围 -->
    <label v-if="mode === 'split'" class="stack gap-1">
      <span class="label">页码范围（留空 = 每页一个文件）</span>
      <input v-model="splitRange" class="field" placeholder="例如 1-3,5,8-10" data-selectable />
    </label>

    <!-- 页面整理 -->
    <div v-if="mode === 'organize' && current" class="stack">
      <p class="muted">点「删」去掉不要的页，箭头调顺序，旋转按 90° 累加。当前保留 {{ order.length }} / {{ current.pages }} 页。</p>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
        <li v-for="(page, slot) in order" :key="page" class="card p-2 stack gap-1.5">
          <div class="row justify-between">
            <span class="tabular text-13px font-500">第 {{ page + 1 }} 页</span>
            <span v-if="rotations[page]" class="caption tabular">{{ rotations[page] }}°</span>
          </div>
          <PdfThumb v-if="previewDoc" :pdf="previewDoc" :index="page" :rotate="rotations[page] || 0" :width="116" />
          <div class="row">
            <button class="btn-ghost h-6 flex-1 px-1" :disabled="slot === 0" @click="movePage(slot, -1)"><span class="i-lucide-chevron-left size-3.5" /></button>
            <button class="btn-ghost h-6 flex-1 px-1" title="旋转 90°" @click="rotatePage(page)"><span class="i-lucide-rotate-cw size-3.5" /></button>
            <button class="btn-ghost h-6 flex-1 px-1" :disabled="slot === order.length - 1" @click="movePage(slot, 1)"><span class="i-lucide-chevron-right size-3.5" /></button>
            <button class="btn-ghost h-6 flex-1 px-1 text-danger" @click="dropPage(page)"><span class="i-lucide-trash-2 size-3.5" /></button>
          </div>
        </li>
      </ul>
      <button v-if="order.length < current.pages" class="btn-plain self-start" @click="order = current.doc.getPages().map((_p, i) => i); rotations = {}">恢复全部页面</button>
    </div>

    <button class="btn-primary self-start" :disabled="!files.length || !!busy" @click="run">
      <span v-if="busy" class="i-lucide-loader-2 size-4 animate-spin" />
      {{ busy || (mode === 'merge' ? '合并并保存' : mode === 'split' ? '拆分到文件夹' : '保存整理结果') }}
    </button>
  </div>
</template>
