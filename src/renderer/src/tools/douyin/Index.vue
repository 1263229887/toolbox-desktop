<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import ctx from '@/services/ctx'

const props = defineProps({ ctx: { type: Object, default: null } })
const api = props.ctx || ctx

const input = ref('')
const stage = ref('idle') // idle | parsing | done | error
const result = ref(null)
const error = ref('')
const attempts = ref([])
const selected = ref(new Set())
const saving = ref(false)
const progress = ref({ done: 0, total: 0 })
const saveResult = ref(null)

let offProgress = null

const images = computed(() => (result.value?.items || []).filter((i) => i.type !== 'video'))
const videos = computed(() => (result.value?.items || []).filter((i) => i.type === 'video'))
const canParse = computed(() => input.value.trim().length > 8 && stage.value !== 'parsing')

// Vue 的键盘修饰符里没有 mod，跨平台只能自己判 metaKey || ctrlKey
function onKey(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    parse()
  }
}

function toggle(index) {
  const next = new Set(selected.value)
  next.has(index) ? next.delete(index) : next.add(index)
  selected.value = next
}

function selectAll() {
  selected.value = new Set(result.value.items.map((_, i) => i))
}

function clearSelection() {
  selected.value = new Set()
}

async function parse() {
  if (!canParse.value) return
  stage.value = 'parsing'
  error.value = ''
  result.value = null
  saveResult.value = null
  selected.value = new Set()
  try {
    const data = await api.call('douyin:parse', { text: input.value })
    result.value = data
    attempts.value = data.attempts || []
    stage.value = 'done'
    // 默认全选：绝大多数场景就是要整组拿走，逐个点反而出错
    selected.value = new Set(data.items.map((_, i) => i))
  } catch (e) {
    error.value = e.message
    stage.value = 'error'
  }
}

async function save() {
  if (!result.value || saving.value) return
  saving.value = true
  progress.value = { done: 0, total: selected.value.size }
  offProgress = api.on('media:progress', (p) => {
    if (p.phase === 'overall') progress.value = { done: p.done, total: p.total }
  })
  try {
    const items = result.value.items.filter((_i, index) => selected.value.has(index))
    const data = await api.call('media:save', { items, folder: 'douyin', title: result.value.title || result.value.id })
    saveResult.value = data
    if (data.failed?.length) error.value = `${data.failed.length} 个文件下载失败：${data.failed[0].error}`
  } catch (e) {
    error.value = e.message
  } finally {
    offProgress?.()
    offProgress = null
    saving.value = false
  }
}

async function reveal(target) {
  await api.call('shell:openPath', { target }).catch(() => {})
}

async function copyLinks() {
  const urls = result.value.items.filter((_i, index) => selected.value.has(index)).map((i) => i.url)
  await navigator.clipboard.writeText(urls.join('\n'))
}

onBeforeUnmount(() => offProgress?.())
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="border-b border-surface-line bg-surface-raised px-6 py-4">
      <div class="flex items-start gap-3">
        <textarea
          v-model="input"
          rows="2"
          class="field min-h-16 flex-1 resize-y py-2 leading-5"
          placeholder="粘贴抖音分享口令（支持带文案的整段口令）"
          data-selectable
          @keydown="onKey"
        />
        <div class="flex w-40 flex-none flex-col gap-2">
          <button class="btn-primary h-9" :disabled="!canParse" @click="parse">
            <span v-if="stage === 'parsing'" class="i-lucide-loader-2 size-4 animate-spin" />
            <span v-else class="i-lucide-zap size-4" />
            {{ stage === 'parsing' ? '解析中' : '开始解析' }}
          </button>
          <span class="muted">⌘/Ctrl + Enter</span>
        </div>
      </div>

      <div v-if="stage === 'error'" class="mt-3 rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">
        {{ error }}
      </div>
      <div v-else-if="error" class="mt-3 rounded-md border border-#f3d5b3 bg-#fdf6ec px-3 py-2 text-12px text-#8a5a1a">{{ error }}</div>
    </div>

    <div v-if="stage === 'parsing'" class="flex flex-1 items-center justify-center">
      <div class="muted flex items-center gap-2">
        <span class="i-lucide-loader-2 size-4 animate-spin" />
        正在依次尝试 SEO 直连 / 解析接口…
      </div>
    </div>

    <div v-else-if="result" class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="rounded bg-surface-sunken px-1.5 py-0.5 text-11px text-ink-2">{{ result.kind === 'video' ? '视频' : '图文' }}</span>
        <span class="text-13px font-600">{{ result.title || '(未取到标题)' }}</span>
        <span v-if="result.author" class="muted">@{{ result.author }}</span>
        <span v-if="result.items.length" class="muted tabular">{{ images.length ? images.length + ' 张' : '' }}{{ videos.length ? (images.length ? ' · ' : '') + '1 个视频' : '' }}</span>
        <span class="ml-auto flex items-center gap-2">
          <span class="muted">链路 {{ result.via }}</span>
          <span v-if="attempts.filter((a) => !a.ok).length" class="cursor-help i-lucide-triangle-alert size-4 text-warn" :title="attempts.filter((a) => !a.ok).map((a) => a.method + '：' + a.message).join('\n')" />
        </span>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <button class="btn-plain" :disabled="saving" @click="selectAll">全选</button>
        <button class="btn-plain" :disabled="saving" @click="clearSelection">清空</button>
        <span class="muted tabular">已选 {{ selected.size }}</span>
        <div class="ml-auto flex items-center gap-2">
          <button class="btn-ghost" @click="copyLinks">复制直链</button>
          <button class="btn-primary" :disabled="saving || !selected.size" @click="save">
            <span v-if="saving" class="i-lucide-loader-2 size-4 animate-spin" />
            {{ saving ? `下载中 ${progress.done}/${progress.total}` : '下载到本地' }}
          </button>
        </div>
      </div>

      <ul v-if="images.length" class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        <li v-for="(item, index) in images" :key="item.url" class="relative">
          <button
            class="block w-full overflow-hidden rounded-md border bg-surface-sunken transition-[border-color,box-shadow] duration-150"
            :class="selected.has(index) ? 'border-accent shadow-[0_0_0_2px_#eaf1ff]' : 'border-surface-line hover:border-surface-line-strong'"
            @click="toggle(index)"
          >
            <img :src="item.url" loading="lazy" class="aspect-[3/4] w-full object-cover" :alt="`第 ${index + 1} 张`" />
          </button>
          <span class="tabular absolute left-1.5 top-1.5 rounded bg-#000b px-1.5 text-11px text-white">{{ index + 1 }}</span>
          <span v-if="selected.has(index)" class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-white">
            <span class="i-lucide-check size-3" />
          </span>
        </li>
      </ul>

      <div v-for="item in videos" :key="item.url" class="card mb-3 flex items-start gap-3 p-3">
        <video :src="item.url" controls preload="metadata" class="max-h-64 w-auto flex-none rounded-md bg-black" @error="item.previewFailed = true" />
        <div class="min-w-0 flex-1">
          <div class="text-13px font-600">无水印视频直链</div>
          <div class="muted mt-1 tabular">
            {{ item.width }}×{{ item.height }} · {{ item.sizeBytes ? (item.sizeBytes / 1048576).toFixed(1) + ' MB' : '大小未知' }}
            <span v-if="item.watermarked" class="text-warn"> · 该路流带平台水印</span>
          </div>
          <div v-if="item.previewFailed" class="muted mt-2">预览被 CDN 拒绝，直接下载仍然可用。</div>
          <label class="mt-2 flex items-center gap-2 text-12px">
            <input type="checkbox" :checked="selected.has(result.items.indexOf(item))" @change="toggle(result.items.indexOf(item))" />
            包含在下载中
          </label>
        </div>
      </div>

      <div v-if="saveResult" class="mt-3 flex items-center gap-2 rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px text-#1c6b40">
        <span class="i-lucide-check-circle size-4" />
        <span class="data-selectable truncate">已保存 {{ saveResult.saved.length }} 个文件到 {{ saveResult.dir }}</span>
        <button class="btn-ghost ml-auto h-6 text-12px" @click="reveal(saveResult.dir)">打开目录</button>
      </div>
    </div>

    <div v-else class="flex flex-1 items-center justify-center">
      <p class="muted">粘贴口令后点「开始解析」。图文走 SEO 直连，视频走解析接口。</p>
    </div>
  </div>
</template>
