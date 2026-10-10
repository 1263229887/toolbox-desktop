<script setup>
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue'

const props = defineProps({
  api: { type: Object, required: true },
  // { secUid?, url?, nickname? } —— 主页链接或裸 sec_uid 都能认
  source: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const phase = ref('loading')
const error = ref('')
const posts = ref([])
const checked = ref(new Set())
const cursor = ref('')
const hasMore = ref(false)
const loadingMore = ref(false)
const listError = ref('')
const nickname = ref('')

const queue = ref({ running: false, stopping: false, done: 0, total: 0, dir: '', saved: [], failed: [] })
const states = ref({})
let offProgress = null

const selected = computed(() => posts.value.filter((p) => checked.value.has(p.id)))
const selectedBytes = computed(() => selected.value.reduce((n, p) => n + (p.sizeBytes || 0), 0))
const pctOf = (s) => (s?.pct ? Math.min(99, s.pct) : 0)

function input() {
  return props.source?.secUid || props.source?.url || ''
}

function setState(id, patch) {
  states.value = { ...states.value, [id]: { ...(states.value[id] || {}), ...patch } }
}

function onProgress(p) {
  const id = p.id || posts.value[p.index]?.id
  if (!id) return
  if (p.phase === 'file') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) : 0
    setState(id, { state: 'downloading', file: p.file, pct })
  } else if (p.phase === 'post') {
    setState(id, { state: p.state, file: p.file || states.value[id]?.file, fileIndex: p.fileIndex, fileTotal: p.fileTotal, waitSec: p.waitSec ?? 0, error: p.error ?? states.value[id]?.error ?? '' })
  } else if (p.phase === 'overall') {
    queue.value = { ...queue.value, done: p.done, total: p.total }
    setState(id, { state: p.state, error: p.error || '', pct: p.state === 'done' ? 100 : states.value[id]?.pct })
  }
}

async function load(append = false) {
  if (!input()) {
    phase.value = 'error'
    error.value = '没有拿到作者标识'
    return
  }
  if (append) loadingMore.value = true
  else phase.value = 'loading'
  error.value = ''
  listError.value = ''
  try {
    const data = await props.api.call('douyin:author-posts', { input: toRaw(input()), count: 20, cursor: append ? cursor.value : '' })
    const list = data.items || []
    posts.value = append ? [...posts.value, ...list] : list
    cursor.value = data.cursor || ''
    hasMore.value = !!data.hasMore
    if (!append) {
      checked.value = new Set()
      states.value = {}
      phase.value = 'list'
      if (data.nickname) nickname.value = data.nickname
    }
    if (!posts.value.length && !append) {
      phase.value = 'error'
      error.value = '这个作者没有可展示的作品（可能设了隐私或被限流）'
    }
  } catch (e) {
    // 翻页失败不该把已经拿到的列表清掉，只在按钮旁边报一句话
    if (append) listError.value = e.message
    else {
      error.value = e.message
      phase.value = 'error'
    }
  } finally {
    loadingMore.value = false
  }
}

function toggle(id) {
  const next = new Set(checked.value)
  next.has(id) ? next.delete(id) : next.add(id)
  checked.value = next
}

function toggleAll() {
  checked.value = checked.value.size === posts.value.length ? new Set() : new Set(posts.value.map((p) => p.id))
}

function stateLabel(s) {
  if (!s) return '排队中'
  if (s.state === 'cooling') return `上游限流，冷却 ${s.waitSec || 60} 秒后继续`
  if (s.state === 'retrying') return '直链过期，重新解析…'
  if (s.state === 'fetching') return '正在取直链…'
  if (s.state === 'downloading') return `下载中 ${pctOf(s)}%${s.fileTotal > 1 ? `（${s.fileIndex}/${s.fileTotal}）` : ''}`
  if (s.state === 'failed') return '失败'
  return '排队中'
}

function fmtDate(sec) {  if (!sec) return ''
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtSize(n) {
  if (!n) return ''
  return n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`
}

function metaOf(p) {
  const bits = [fmtDate(p.createdAt)]
  if (p.kind === 'video') bits.push(p.durationMs ? `${Math.round(p.durationMs / 1000)}s` : '视频')
  else bits.push(`${p.items.length || ''} 张`)
  if (p.sizeBytes) bits.push(fmtSize(p.sizeBytes))
  return bits.filter(Boolean).join(' · ')
}

async function start() {
  if (!selected.value.length || queue.value.running) return
  offProgress?.()
  offProgress = props.api.on('douyin:batch-progress', onProgress)
  states.value = {}
  queue.value = { running: true, stopping: false, done: 0, total: selected.value.length, dir: '', saved: [], failed: [] }
  try {
    const payload = selected.value.map((p) => toRaw(p))
    const data = await props.api.call('douyin:batch-save', { posts: payload, author: nickname.value || '作者作品' })
    queue.value = { ...queue.value, running: false, dir: data.dir, saved: data.saved || [], failed: data.failed || [], stopping: false }
    if (data.stopped) error.value = '已停止，未下载的部分可以再来一次'
  } catch (e) {
    queue.value = { ...queue.value, running: false }
    error.value = e.message
  } finally {
    offProgress?.()
    offProgress = null
  }
}

async function stop() {
  if (!queue.value.running) return
  queue.value = { ...queue.value, stopping: true }
  await props.api.call('douyin:batch-stop', {})
}

async function openDir() {
  if (queue.value.dir) await props.api.call('shell:openPath', { target: queue.value.dir })
}

async function retryFailed() {
  const ids = new Set((queue.value.failed || []).map((f) => f.id))
  if (!ids.size) return
  checked.value = ids
  await start()
}

watch(() => props.source, () => {
  nickname.value = props.source?.nickname || ''
  load()
}, { immediate: true })

onBeforeUnmount(() => offProgress?.())
</script>

<template>
  <section class="card stack p-4">
    <div class="row justify-between">
      <div class="row min-w-0">
        <span class="title truncate">{{ nickname || 'TA 的作品' }}</span>
        <span v-if="phase === 'list'" class="muted shrink-0">共取到 {{ posts.length }} 条{{ hasMore ? '（还有更多）' : '' }}</span>
      </div>
      <button class="btn-ghost h-7 px-2" @click="emit('close')"><span class="i-lucide-x size-4" />收起</button>
    </div>

    <p v-if="phase === 'loading'" class="muted row"><span class="i-lucide-loader-2 size-4 animate-spin" />正在拉取作品列表…</p>

    <template v-if="phase === 'list'">
      <div class="row justify-between">
        <label class="row cursor-pointer select-none">
          <input type="checkbox" :checked="checked.size === posts.length && posts.length > 0" @change="toggleAll" />
          <span class="text-13px">全选</span>
        </label>
        <span class="caption">已选 {{ selected.length }}{{ selectedBytes ? ` · 约 ${fmtSize(selectedBytes)}` : '' }}</span>
      </div>

      <ul class="stack gap-1 overflow-auto max-h-[46vh] pr-1">
        <li v-for="p in posts" :key="p.id" class="row gap-2 rounded-md border border-transparent px-1.5 py-1.5 transition-colors duration-[var(--m-micro)] hover:border-surface-line hover:bg-surface-sunken">
          <input type="checkbox" :checked="checked.has(p.id)" :disabled="queue.running" class="shrink-0" @change="toggle(p.id)" />
          <img v-if="p.cover" :src="p.cover" loading="lazy" alt="" class="size-11 shrink-0 rounded border border-surface-line bg-surface-sunken object-cover" />
          <span v-else class="size-11 shrink-0 rounded border border-surface-line bg-surface-sunken" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-13px">{{ p.title || '（无标题）' }}</p>
            <p class="caption truncate">{{ metaOf(p) }}</p>
            <p v-if="states[p.id] && states[p.id].state !== 'done'" class="caption truncate" :class="states[p.id].state === 'failed' ? 'text-#8c2c25' : 'text-accent'">{{ stateLabel(states[p.id]) }}</p>
            <p v-else-if="states[p.id]?.state === 'done'" class="caption truncate text-#1c6b40">已完成</p>
            <p v-if="states[p.id]?.error && states[p.id].state === 'failed'" class="caption truncate text-#8c2c25">{{ states[p.id].error }}</p>
          </div>
        </li>
      </ul>

      <div class="row">
        <button v-if="hasMore" class="btn-plain shrink-0" :disabled="loadingMore" @click="load(true)">
          <span v-if="loadingMore" class="i-lucide-loader-2 size-4 animate-spin" />再加载 20 条
        </button>
        <span v-if="listError" class="caption min-w-0 flex-1 truncate text-right text-#8c2c25">{{ listError }}</span>
        <span v-else class="flex-1" />
        <button v-if="queue.running" class="btn-plain" @click="stop">
          <span class="i-lucide-square size-3.5" />{{ queue.stopping ? '正在停止…' : '停止' }}
        </button>
        <button class="btn-primary" :disabled="!selected.length || queue.running" @click="start">
          <span v-if="queue.running" class="i-lucide-loader-2 size-4 animate-spin" />
          下载已选 {{ selected.length }}
        </button>
      </div>

      <div v-if="queue.total" class="stack gap-1">
        <div class="h-1 overflow-hidden rounded-full bg-surface-sunken">
          <div class="h-full rounded-full bg-accent transition-[width] duration-[var(--m-move)]" :style="{ width: `${Math.round(queue.done / queue.total * 100)}%` }" />
        </div>
        <div class="row justify-between">
          <span class="caption">{{ queue.running ? `队列进行中 ${queue.done} / ${queue.total}` : `完成 ${queue.done} / ${queue.total}，落地 ${queue.saved.length} 个文件` }}</span>
          <div class="row">
            <button v-if="queue.failed.length && !queue.running" class="btn-ghost h-6 px-2 text-12px" @click="retryFailed">重试失败 {{ queue.failed.length }}</button>
            <button v-if="queue.dir && !queue.running" class="btn-ghost h-6 px-2 text-12px" @click="openDir"><span class="i-lucide-folder-open size-3.5" />打开目录</button>
          </div>
        </div>
        <p v-if="queue.failed.length && !queue.running" class="caption text-#8c2c25">{{ queue.failed.length }} 条失败：{{ queue.failed[0].error }}</p>
      </div>

      <p class="caption">列表里的直链只有约 3 小时有效期，所以队列是一条下完再进下一条；中途关掉软件，下次要重新拉列表。</p>
    </template>

    <p v-if="phase === 'error'" class="rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">{{ error }}</p>
  </section>
</template>
