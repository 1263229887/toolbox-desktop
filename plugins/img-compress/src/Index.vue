<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({ ctx: { type: Object, required: true } })
const api = props.ctx

const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }

const items = ref([])
const opts = ref({ format: 'image/jpeg', quality: 0.82, maxSide: 0 })
const error = ref('')
const busy = ref(false)
const saved = ref(null)
let timer = null

const before = computed(() => items.value.reduce((n, i) => n + i.bytes.length, 0))
const after = computed(() => items.value.reduce((n, i) => n + (i.out?.bytes.length || 0), 0))
const ratio = computed(() => (before.value ? Math.round((1 - after.value / before.value) * 100) : 0))
const ready = computed(() => items.value.length && items.value.every((i) => i.out))

function mb(n) {
  return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB'
}

async function pick() {
  const paths = await api.call('dialog:pickFiles', { multiple: true })
  if (!paths?.length) return
  busy.value = true
  try {
    const loaded = await api.call('files:read', { filePaths: paths })
    for (const f of loaded) {
      const decoded = await decode(f.data, f.mime)
      if (!decoded) {
        error.value = `无法解码：${f.name}`
        continue
      }
      items.value.push({ path: f.path, name: f.name, bytes: f.data, ...decoded })
    }
    scheduleRecompute()
  } finally {
    busy.value = false
  }
}

async function decode(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  try {
    const el = await loadImage(url)
    return { url, w: el.naturalWidth, h: el.naturalHeight, out: null }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = reject
    el.src = url
  })
}

// 参数一改就重算：体积数字必须是真量出来的，不能显示估算值
function scheduleRecompute() {
  clearTimeout(timer)
  timer = setTimeout(recompute, 120)
}

async function recompute() {
  if (!items.value.length) return
  busy.value = true
  try {
    for (const item of items.value) {
      const el = await loadImage(item.url)
      const scale = opts.value.maxSide ? Math.min(1, opts.value.maxSide / Math.max(item.w, item.h)) : 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(item.w * scale))
      canvas.height = Math.max(1, Math.round(item.h * scale))
      const g = canvas.getContext('2d')
      if (opts.value.format === 'image/jpeg') {
        // JPEG 没有透明通道，透明 PNG 直接压会发黑，必须先铺白底
        g.fillStyle = '#fff'
        g.fillRect(0, 0, canvas.width, canvas.height)
      }
      g.drawImage(el, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise((r) => canvas.toBlob(r, opts.value.format, opts.value.quality))
      item.out = { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height }
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

watch(opts, scheduleRecompute, { deep: true })

async function save() {
  const dir = await api.call('dialog:pickFolder', {})
  if (!dir) return
  busy.value = true
  error.value = ''
  try {
    const used = new Set()
    const payload = items.value.map((item, i) => {
      const base = item.name.replace(/\.[^.]+$/, '') || 'image'
      let name = `${base}.${EXT[opts.value.format]}`
      for (let n = 2; used.has(name); n++) name = `${base}-${n}.${EXT[opts.value.format]}`
      used.add(name)
      return { name: `${String(i + 1).padStart(2, '0')}-${name}`, data: item.out.bytes }
    })
    saved.value = await api.call('files:writeBatch', { dir, items: payload })
    if (saved.value.failed?.length) error.value = `${saved.value.failed.length} 张写入失败：${saved.value.failed[0].error}`
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function remove(index) {
  URL.revokeObjectURL(items.value[index].url)
  items.value.splice(index, 1)
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  for (const i of items.value) URL.revokeObjectURL(i.url)
})
</script>

<template>
  <div class="cmp">
    <div class="cmp-bar">
      <button class="cmp-btn cmp-btn-primary" :disabled="busy" @click="pick">
        <span class="cmp-dot" />添加图片
      </button>
      <span class="cmp-hint">{{ items.length }} 张 · {{ mb(before) }} → {{ mb(after) }}（省 {{ ratio }}%）</span>
      <button class="cmp-btn" :disabled="!ready || busy" @click="save">保存全部</button>
    </div>

    <div class="cmp-opts">
      <label>
        <span>格式</span>
        <select v-model="opts.format">
          <option value="image/jpeg">JPEG</option>
          <option value="image/webp">WebP</option>
          <option value="image/png">PNG</option>
        </select>
      </label>
      <label>
        <span>质量 {{ Math.round(opts.quality * 100) }}</span>
        <input v-model.number="opts.quality" type="range" min="0.4" max="0.98" step="0.02" :disabled="opts.format === 'image/png'" />
      </label>
      <label>
        <span>最长边</span>
        <input v-model.number="opts.maxSide" type="number" min="0" step="100" placeholder="0 = 不缩放" />
      </label>
    </div>

    <p v-if="error" class="cmp-warn">{{ error }}</p>

    <table v-if="items.length" class="cmp-table">
      <thead>
        <tr><th>#</th><th>文件</th><th>尺寸</th><th>原</th><th>压缩后</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="(item, index) in items" :key="item.path">
          <td class="num">{{ index + 1 }}</td>
          <td class="name">{{ item.name }}</td>
          <td class="num">{{ item.out ? `${item.out.w}×${item.out.h}` : `${item.w}×${item.h}` }}</td>
          <td class="num">{{ mb(item.bytes.length) }}</td>
          <td class="num">{{ item.out ? mb(item.out.bytes.length) : '…' }}</td>
          <td><button class="cmp-x" @click="remove(index)">移除</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="cmp-empty">还没有图片</p>

    <p v-if="saved" class="cmp-ok">
      已写入 {{ saved.written.length }} 个文件到 {{ saved.dir }}
      <button class="cmp-link" @click="api.call('shell:openPath', { target: saved.dir })">打开目录</button>
    </p>
  </div>
</template>

<!-- 样式在 src/style.css，由 index.js 注入；scoped 的 data-v 在独立 ESM 构建里对不上宿主 DOM -->

