<script setup>
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue'
import ctx from '@/services/ctx'

const props = defineProps({ ctx: { type: Object, default: null } })
const api = props.ctx || ctx

const input = ref('')
const fromClipboard = ref(false)
const stage = ref('idle') // idle | parsing | done | error
const result = ref(null)
const error = ref('')
const attempts = ref([])
const selected = ref(new Set())
const saving = ref(false)
const progress = ref({ done: 0, total: 0 })
const saveResult = ref(null)
const preview = ref(-1)

let offProgress = null

const previewItem = computed(() => (preview.value >= 0 ? images.value[preview.value] : null))

function openPreview(index) {
  preview.value = index
}

function stepPreview(delta) {
  const n = images.value.length
  if (!n) return
  preview.value = (preview.value + delta + n) % n
}

function onWindowKey(e) {
  if (preview.value < 0) return
  if (e.key === 'Escape') preview.value = -1
  else if (e.key === 'ArrowRight') stepPreview(1)
  else if (e.key === 'ArrowLeft') stepPreview(-1)
}

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
    // 必须脱掉 Vue 的 reactive 代理：Proxy 过 IPC 会被 structuredClone 拒收（DataCloneError），
    // 表现就是点「下载到本地」毫无反应
    const items = result.value.items.filter((_i, index) => selected.value.has(index)).map((i) => toRaw(i))
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

onMounted(async () => {
  window.addEventListener('keydown', onWindowKey)
  const text = await api.call('clipboard:readText').catch(() => '')
  if (!input.value && /douyin\.com/.test(text)) {
    input.value = text
    fromClipboard.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  offProgress?.()
})
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
          @input="fromClipboard = false"
          @keydown="onKey"
        />
        <div class="flex w-40 flex-none flex-col gap-2">
          <button class="btn-primary h-9" :disabled="!canParse" @click="parse">
            <span v-if="stage === 'parsing'" class="i-lucide-loader-2 size-4 animate-spin" />
            <span v-else class="i-lucide-zap size-4" />
            {{ stage === 'parsing' ? '解析中' : '开始解析' }}
          </button>
          <span v-if="fromClipboard" class="muted flex items-center gap-1"><span class="i-lucide-clipboard size-3" />已从剪贴板读取</span>
          <span v-else class="muted">⌘/Ctrl + Enter</span>
        </div>
      </div>

      <Transition name="tip">
        <div v-if="stage === 'error'" class="mt-3 rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">
          {{ error }}
        </div>
        <div v-else-if="error" class="mt-3 rounded-md border border-#f3d5b3 bg-#fdf6ec px-3 py-2 text-12px text-#8a5a1a">{{ error }}</div>
      </Transition>
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
          <!-- 点图看大图，勾选决定下载哪些：壁纸场景里「先看清楚」比「先选中」更高频 -->
          <button
            class="block w-full overflow-hidden rounded-md border bg-surface-sunken transition-[border-color,box-shadow] duration-150"
            :class="selected.has(index) ? 'border-accent shadow-[0_0_0_2px_#eaf1ff]' : 'border-surface-line hover:border-surface-line-strong'"
            @click="openPreview(index)"
          >
            <img :src="item.url" loading="lazy" class="aspect-[3/4] w-full object-cover" :alt="`第 ${index + 1} 张`" />
          </button>
          <span class="tabular absolute left-1.5 top-1.5 rounded bg-#000b px-1.5 text-11px text-white">{{ index + 1 }}</span>
          <button
            class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full border transition-colors duration-150"
            :class="selected.has(index) ? 'border-accent bg-accent text-white' : 'border-white/70 bg-#0005 text-transparent hover:bg-#0009'"
            :title="selected.has(index) ? '取消选择' : '选入下载'"
            @click.stop="toggle(index)"
          >
            <span class="i-lucide-check size-3" />
          </button>
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

      <Transition name="tip">
        <div v-if="saveResult" class="mt-3 flex items-center gap-2 rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px text-#1c6b40">
          <span class="i-lucide-check-circle size-4" />
          <span class="data-selectable truncate">已保存 {{ saveResult.saved.length }} 个文件到 {{ saveResult.dir }}</span>
          <button class="btn-ghost ml-auto h-6 text-12px" @click="reveal(saveResult.dir)">打开目录</button>
        </div>
      </Transition>
    </div>

    <div v-else class="flex flex-1 items-center justify-center">
      <p class="muted">粘贴口令后点「开始解析」。图文走 SEO 直连，视频走解析接口。</p>
    </div>

    <Teleport to="body">
      <Transition name="viewer">
        <div v-if="previewItem" class="fixed inset-0 z-50 flex flex-col bg-#000d" data-chrome @click.self="preview = -1">
          <div class="flex h-11 flex-none items-center gap-3 px-4 text-12px text-white/75">
            <span class="tabular">{{ preview + 1 }} / {{ images.length }}</span>
            <span class="truncate">{{ result.title }}</span>
            <button class="btn-ghost ml-auto h-7 flex-none text-white/80 hover:bg-white/10 hover:text-white" @click="toggle(preview)">
              {{ selected.has(preview) ? '取消选择' : '选入下载' }}
            </button>
            <button class="btn-ghost h-7 flex-none text-white/80 hover:bg-white/10 hover:text-white" @click="preview = -1">关闭 Esc</button>
          </div>
          <div class="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
            <img :src="previewItem.url" class="max-h-full max-w-full object-contain" :alt="`第 ${preview + 1} 张`" />
            <button
              v-if="images.length > 1"
              class="btn-ghost absolute left-3 size-9 flex-none bg-#ffffff14 text-white hover:bg-#ffffff26"
              @click="stepPreview(-1)"
            >
              <span class="i-lucide-chevron-left size-5" />
            </button>
            <button
              v-if="images.length > 1"
              class="btn-ghost absolute right-3 size-9 flex-none bg-#ffffff14 text-white hover:bg-#ffffff26"
              @click="stepPreview(1)"
            >
              <span class="i-lucide-chevron-right size-5" />
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 提示条出现是「有结果」的反馈：淡入 + 2px，140ms，够被看见但不打断读表 */
.tip-enter-active,
.tip-leave-active {
  transition:
    opacity var(--m-micro) var(--m-enter),
    transform var(--m-micro) var(--m-enter);
}

.tip-enter-from,
.tip-leave-to {
  opacity: 0;
  transform: translateY(2px);
}

/* 大图浮层：只做淡入 + 0.6% 缩放，位移走 --m-shift 之外另给极小值，避免"弹出来"的廉价感 */
.viewer-enter-active,
.viewer-leave-active {
  transition:
    opacity var(--m-micro) var(--m-enter),
    transform var(--m-micro) var(--m-enter);
}

.viewer-enter-from,
.viewer-leave-to {
  opacity: 0;
  transform: scale(0.994);
}
</style>
