<script setup>
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue'
import ctx from '@/services/ctx'

const props = defineProps({ ctx: { type: Object, default: null } })
const api = props.ctx || ctx

const input = ref('')
const fromClipboard = ref(false)
const stage = ref('idle')
const result = ref(null)
const error = ref('')
const selected = ref(new Set())
const saving = ref(false)
const progress = ref({ done: 0, total: 0 })
const saveResult = ref(null)
const preview = ref(-1)
const parsingStep = ref(0)
const parsingSeconds = ref(0)

const PARSING_STEPS = ['读取作品信息', '定位清晰媒体', '整理下载结果']
let offProgress = null
let parseClock = null
let parsePulse = null

const images = computed(() => (result.value?.items || []).filter((i) => i.type !== 'video'))
const videos = computed(() => (result.value?.items || []).filter((i) => i.type === 'video'))
const previewItem = computed(() => (preview.value >= 0 ? images.value[preview.value] : null))
const canParse = computed(() => input.value.trim().length > 8 && stage.value !== 'parsing')
const parsingLabel = computed(() => PARSING_STEPS[parsingStep.value])

function startParsingMotion() {
  parsingStep.value = 0
  parsingSeconds.value = 0
  clearInterval(parseClock)
  clearInterval(parsePulse)
  parseClock = setInterval(() => parsingSeconds.value++, 1000)
  parsePulse = setInterval(() => {
    parsingStep.value = Math.min(parsingStep.value + 1, PARSING_STEPS.length - 1)
  }, 1500)
}

function stopParsingMotion() {
  clearInterval(parseClock)
  clearInterval(parsePulse)
  parseClock = null
  parsePulse = null
}

function openPreview(index) { preview.value = index }

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

function onKey(e) {
  if (e.key !== 'Enter' || e.isComposing) return
  e.preventDefault()
  parse()
}

function toggle(index) {
  const next = new Set(selected.value)
  next.has(index) ? next.delete(index) : next.add(index)
  selected.value = next
}

function selectAll() { selected.value = new Set(result.value.items.map((_, i) => i)) }
function clearSelection() { selected.value = new Set() }

function videoFrameStyle(item) {
  const width = Number(item.width) || 9
  const height = Number(item.height) || 16
  return { '--media-ratio': `${width} / ${height}` }
}

async function parse() {
  if (!canParse.value) return
  stage.value = 'parsing'
  error.value = ''
  result.value = null
  saveResult.value = null
  selected.value = new Set()
  startParsingMotion()
  try {
    const data = await api.call('douyin:parse', { text: input.value })
    result.value = data
    stage.value = 'done'
    selected.value = new Set(data.items.map((_, i) => i))
  } catch (e) {
    error.value = e.message
    stage.value = 'error'
  } finally {
    stopParsingMotion()
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

async function reveal(target) { await api.call('shell:openPath', { target }).catch(() => {}) }

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
  stopParsingMotion()
  offProgress?.()
})
</script>

<template>
  <div class="parse-page flex min-h-full flex-col">
    <div class="parse-command-wrap">
      <div class="parse-command">
        <div class="parse-field">
          <label for="douyin-share">抖音分享口令</label>
          <div class="parse-input-row">
            <span class="i-lucide-link-2 size-4 flex-none text-ink-3" />
            <input id="douyin-share" v-model="input" type="text" placeholder="粘贴整段分享口令或短链接" data-selectable autocomplete="off" @input="fromClipboard = false" @keydown="onKey" />
            <span v-if="fromClipboard" class="clipboard-hint"><span class="i-lucide-clipboard-check size-3" />剪贴板</span>
          </div>
          <span class="parse-shortcut">按 Enter 开始，支持直接粘贴带文案的整段内容</span>
        </div>
        <button class="parse-action" :disabled="!canParse" @click="parse">
          <span class="parse-action-glint" />
          <span v-if="stage === 'parsing'" class="i-lucide-loader-circle size-4 animate-spin" />
          <span v-else class="i-lucide-sparkles size-4" />
          <span>{{ stage === 'parsing' ? '正在解析' : '开始解析' }}</span>
        </button>
      </div>
      <Transition name="tip">
        <div v-if="stage === 'error'" class="parse-error"><span class="i-lucide-circle-alert size-4 flex-none" />{{ error }}</div>
        <div v-else-if="error" class="parse-warning">{{ error }}</div>
      </Transition>
    </div>

    <div v-if="stage === 'parsing'" class="parsing-state">
      <div class="parse-core" aria-hidden="true"><span class="parse-core-dot" /><span class="parse-scanner" /></div>
      <p class="parsing-title">{{ parsingLabel }}</p>
      <p class="parsing-copy">正在为你准备可下载的清晰内容</p>
      <div class="parsing-steps" aria-hidden="true"><span v-for="(_label, index) in PARSING_STEPS" :key="index" :class="{ active: index <= parsingStep }" /></div>
      <span class="parsing-time tabular">已等待 {{ parsingSeconds }} 秒</span>
    </div>

    <div v-else-if="result" class="result-scroll min-h-0 flex-1 overflow-y-auto">
      <div class="result-head">
        <div class="min-w-0">
          <div class="mb-1 flex items-center gap-2">
            <span class="result-kind">{{ result.kind === 'video' ? '视频' : '图文' }}</span>
            <span class="muted tabular">{{ images.length ? images.length + ' 张图片' : '' }}{{ videos.length ? (images.length ? ' · ' : '') + '1 个视频' : '' }}</span>
          </div>
          <h2 class="truncate text-14px font-650">{{ result.title || '解析完成' }}</h2>
          <p v-if="result.author" class="muted mt-0.5">@{{ result.author }}</p>
        </div>
        <div class="result-actions">
          <button class="btn-ghost" @click="copyLinks"><span class="i-lucide-copy size-3.5" />复制直链</button>
          <button class="btn-primary" :disabled="saving || !selected.size" @click="save">
            <span v-if="saving" class="i-lucide-loader-2 size-4 animate-spin" />
            <span v-else class="i-lucide-download size-4" />
            {{ saving ? `下载中 ${progress.done}/${progress.total}` : '下载到本地' }}
          </button>
        </div>
      </div>

      <div class="selection-row">
        <button class="btn-plain" :disabled="saving" @click="selectAll">全选</button>
        <button class="btn-plain" :disabled="saving" @click="clearSelection">清空</button>
        <span class="muted tabular">已选 {{ selected.size }}</span>
      </div>

      <ul v-if="images.length" class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        <li v-for="(item, index) in images" :key="item.url" class="relative">
          <button class="block w-full overflow-hidden rounded-md border bg-surface-sunken transition-[border-color,box-shadow] duration-150" :class="selected.has(index) ? 'border-accent shadow-[0_0_0_2px_#eaf1ff]' : 'border-surface-line hover:border-surface-line-strong'" @click="openPreview(index)">
            <img :src="item.url" loading="lazy" class="aspect-[3/4] w-full object-cover" :alt="`第 ${index + 1} 张`" />
          </button>
          <span class="tabular absolute left-1.5 top-1.5 rounded bg-#000b px-1.5 text-11px text-white">{{ index + 1 }}</span>
          <button class="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full border transition-colors duration-150" :class="selected.has(index) ? 'border-accent bg-accent text-white' : 'border-white/70 bg-#0005 text-transparent hover:bg-#0009'" :title="selected.has(index) ? '取消选择' : '选入下载'" @click.stop="toggle(index)">
            <span class="i-lucide-check size-3" />
          </button>
        </li>
      </ul>

      <div v-for="item in videos" :key="item.url" class="video-result">
        <div class="video-stage" :style="videoFrameStyle(item)">
          <img v-if="result.cover && !item.previewReady" :src="result.cover" class="video-cover" alt="" />
          <div v-if="!item.previewReady" class="video-pending">
            <span class="video-pending-orbit"><span /></span>
            <span>{{ item.previewFailed ? '预览暂不可用' : '正在准备预览' }}</span>
          </div>
          <video v-show="!item.previewFailed" :src="item.url" :poster="result.cover || undefined" controls preload="metadata" class="video-player" :class="{ ready: item.previewReady }" @loadeddata="item.previewReady = true" @error="item.previewFailed = true" />
        </div>
        <div class="video-info">
          <span class="video-label"><span class="i-lucide-badge-check size-3.5" />解析完成</span>
          <h3>清晰视频已就绪</h3>
          <p class="muted tabular">{{ item.width || '—' }}×{{ item.height || '—' }}<span v-if="item.sizeBytes"> · {{ (item.sizeBytes / 1048576).toFixed(1) }} MB</span></p>
          <p v-if="item.previewFailed" class="muted mt-2">当前网络无法加载预览，下载不受影响。</p>
          <label class="video-select"><input type="checkbox" :checked="selected.has(result.items.indexOf(item))" @change="toggle(result.items.indexOf(item))" />包含在下载中</label>
        </div>
      </div>

      <Transition name="tip">
        <div v-if="saveResult" class="save-result">
          <span class="i-lucide-check-circle size-4 flex-none" />
          <span class="data-selectable truncate">已保存 {{ saveResult.saved.length }} 个文件到 {{ saveResult.dir }}</span>
          <button class="btn-ghost ml-auto h-6 text-12px" @click="reveal(saveResult.dir)">打开目录</button>
        </div>
      </Transition>
    </div>

    <div v-else class="parse-empty">
      <span class="empty-mark"><span class="i-lucide-wand-sparkles size-5" /></span>
      <p>粘贴分享口令，一键取回清晰内容</p>
      <span>结果会在这里出现</span>
    </div>

    <Teleport to="body">
      <Transition name="viewer">
        <div v-if="previewItem" class="fixed inset-0 z-50 flex flex-col bg-#000d" data-chrome @click.self="preview = -1">
          <div class="flex h-11 flex-none items-center gap-3 px-4 text-12px text-white/75">
            <span class="tabular">{{ preview + 1 }} / {{ images.length }}</span>
            <span class="truncate">{{ result.title }}</span>
            <button class="btn-ghost ml-auto h-7 flex-none text-white/80 hover:bg-white/10 hover:text-white" @click="toggle(preview)">{{ selected.has(preview) ? '取消选择' : '选入下载' }}</button>
            <button class="btn-ghost h-7 flex-none text-white/80 hover:bg-white/10 hover:text-white" @click="preview = -1">关闭 Esc</button>
          </div>
          <div class="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
            <img :src="previewItem.url" class="max-h-full max-w-full object-contain" :alt="`第 ${preview + 1} 张`" />
            <button v-if="images.length > 1" class="btn-ghost absolute left-3 size-9 flex-none bg-#ffffff14 text-white hover:bg-#ffffff26" @click="stepPreview(-1)"><span class="i-lucide-chevron-left size-5" /></button>
            <button v-if="images.length > 1" class="btn-ghost absolute right-3 size-9 flex-none bg-#ffffff14 text-white hover:bg-#ffffff26" @click="stepPreview(1)"><span class="i-lucide-chevron-right size-5" /></button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.parse-page { min-width: 0; }
.parse-command-wrap { border-bottom: 1px solid var(--tb-line); background: rgba(255, 255, 255, 0.78); padding: 18px clamp(16px, 3vw, 30px); backdrop-filter: blur(12px); }
.parse-command { display: flex; max-width: 980px; align-items: stretch; gap: 12px; margin: 0 auto; }
.parse-field { min-width: 0; flex: 1; }
.parse-field > label { display: block; margin-bottom: 6px; color: var(--tb-ink-2); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
.parse-input-row { display: flex; height: 42px; align-items: center; gap: 9px; border: 1px solid var(--tb-line-strong); border-radius: 9px; padding: 0 12px; background: var(--tb-surface-raised); transition: border-color var(--m-standard), box-shadow var(--m-standard); }
.parse-input-row:focus-within { border-color: var(--tb-accent); box-shadow: var(--tb-focus); }
.parse-input-row input { min-width: 0; flex: 1; font-size: 13px; }
.parse-input-row input::placeholder { color: var(--tb-ink-4); }
.clipboard-hint { display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--tb-accent); font-size: 10px; }
.parse-shortcut { display: block; margin-top: 5px; color: var(--tb-ink-4); font-size: 10px; }
.parse-action { position: relative; display: inline-flex; width: 138px; height: 42px; align-self: flex-end; align-items: center; justify-content: center; gap: 7px; overflow: hidden; border-radius: 9px; color: white; background: var(--tb-accent); font-size: 12px; font-weight: 650; box-shadow: 0 7px 18px rgba(60, 94, 232, 0.2); transition: background-color var(--m-micro), transform var(--m-micro), box-shadow var(--m-standard); }
.parse-action:hover:not(:disabled) { background: var(--tb-accent-hover); box-shadow: 0 9px 22px rgba(60, 94, 232, 0.28); transform: translateY(-1px); }
.parse-action:active:not(:disabled) { transform: translateY(0) scale(0.985); }
.parse-action:disabled { opacity: 0.45; box-shadow: none; cursor: default; }
.parse-action-glint { position: absolute; inset: 0; background: linear-gradient(110deg, transparent 25%, rgba(255,255,255,.34), transparent 65%); transform: translateX(-130%); }
.parse-action:hover .parse-action-glint { animation: button-glint 720ms var(--m-enter); }
.parse-error, .parse-warning { display: flex; max-width: 980px; align-items: center; gap: 7px; margin: 10px auto 0; border-radius: 7px; padding: 8px 10px; font-size: 12px; }
.parse-error { border: 1px solid #f3c6c2; color: #8c2c25; background: #fdf1f0; }
.parse-warning { border: 1px solid #f3d5b3; color: #8a5a1a; background: #fdf6ec; }

.parsing-state { display: flex; min-height: 360px; flex: 1; flex-direction: column; align-items: center; justify-content: center; padding: 28px; }
.parse-core { position: relative; width: 96px; height: 96px; overflow: hidden; border: 1px solid rgba(60, 94, 232, 0.35); border-radius: 50%; background: rgba(229, 234, 255, 0.52); box-shadow: inset 0 0 0 16px rgba(255,255,255,.42), 0 12px 34px rgba(60,94,232,.1); }
.parse-core::before { position: absolute; inset: 8px; content: ''; border: 1px dashed rgba(60, 94, 232, 0.52); border-radius: 50%; animation: parse-orbit 4s linear infinite; }
.parse-core-dot { position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; border-radius: 50%; background: var(--tb-accent); box-shadow: 0 0 0 8px rgba(60,94,232,.11); transform: translate(-50%, -50%); animation: parse-pulse 1.5s ease-in-out infinite; }
.parse-scanner { position: absolute; left: 16px; right: 16px; top: 50%; height: 1px; background: var(--tb-accent); box-shadow: 0 0 10px rgba(60,94,232,.7); animation: parse-scan 1.8s ease-in-out infinite; }
.parsing-title { margin-top: 18px; color: var(--tb-ink-1); font-size: 14px; font-weight: 650; }
.parsing-copy { margin-top: 4px; color: var(--tb-ink-3); font-size: 12px; }
.parsing-steps { display: flex; gap: 5px; margin-top: 16px; }
.parsing-steps span { width: 24px; height: 3px; overflow: hidden; border-radius: 999px; background: var(--tb-line); transition: background-color 280ms, transform 280ms; }
.parsing-steps span.active { background: var(--tb-accent); transform: scaleX(1.08); }
.parsing-time { margin-top: 8px; color: var(--tb-ink-4); font-size: 10px; }

.result-scroll { padding: 20px clamp(16px, 3vw, 30px) 28px; }
.result-head { display: flex; align-items: center; gap: 18px; max-width: 1020px; margin: 0 auto; padding-bottom: 14px; border-bottom: 1px solid var(--tb-line); }
.result-kind { border-radius: 5px; padding: 2px 6px; color: var(--tb-accent); background: var(--tb-accent-soft); font-size: 10px; font-weight: 700; }
.result-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.selection-row { display: flex; max-width: 1020px; align-items: center; gap: 7px; margin: 10px auto 12px; }
.result-scroll > ul, .result-scroll > .video-result, .result-scroll > .save-result { max-width: 1020px; margin-left: auto; margin-right: auto; }
.video-result { display: flex; align-items: center; gap: clamp(20px, 4vw, 46px); border: 1px solid var(--tb-line); border-radius: 12px; padding: 18px; background: rgba(255,255,255,.82); }
.video-stage { position: relative; height: min(300px, 46vh); width: auto; max-width: 46%; aspect-ratio: var(--media-ratio); flex: none; overflow: hidden; border: 1px solid var(--tb-line); border-radius: 10px; background: #111827; box-shadow: 0 12px 26px rgba(31,42,68,.12); }
.video-cover, .video-player { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.video-cover { filter: saturate(.9) brightness(.72); }
.video-player { z-index: 2; opacity: 0; transition: opacity 220ms var(--m-enter); }
.video-player.ready { opacity: 1; }
.video-pending { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: rgba(255,255,255,.82); background: linear-gradient(180deg, rgba(16,24,40,.18), rgba(16,24,40,.55)); font-size: 11px; }
.video-pending-orbit { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid rgba(255,255,255,.38); border-radius: 50%; animation: parse-orbit 1.8s linear infinite; }
.video-pending-orbit span { width: 5px; height: 5px; border-radius: 50%; background: white; box-shadow: 0 0 10px white; transform: translateY(-11px); }
.video-info { min-width: 0; flex: 1; }
.video-label { display: inline-flex; align-items: center; gap: 5px; color: var(--tb-accent); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.video-info h3 { margin-top: 8px; font-size: 18px; font-weight: 650; letter-spacing: -.02em; }
.video-info p { margin-top: 5px; }
.video-select { display: flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--tb-ink-2); font-size: 12px; }
.video-select input { accent-color: var(--tb-accent); }
.save-result { display: flex; align-items: center; gap: 8px; margin-top: 12px; border: 1px solid #b7e3cc; border-radius: 7px; padding: 8px 10px; color: #1c6b40; background: #effaf3; font-size: 12px; }
.parse-empty { display: flex; min-height: 330px; flex: 1; flex-direction: column; align-items: center; justify-content: center; color: var(--tb-ink-3); }
.empty-mark { display: grid; width: 48px; height: 48px; place-items: center; border: 1px solid var(--tb-line); border-radius: 12px; color: var(--tb-accent); background: rgba(255,255,255,.68); box-shadow: 0 8px 22px rgba(32,45,72,.06); }
.parse-empty p { margin-top: 13px; color: var(--tb-ink-2); font-size: 13px; font-weight: 600; }
.parse-empty > span:last-child { margin-top: 3px; color: var(--tb-ink-4); font-size: 11px; }

.tip-enter-active, .tip-leave-active, .viewer-enter-active, .viewer-leave-active { transition: opacity var(--m-micro) var(--m-enter), transform var(--m-micro) var(--m-enter); }
.tip-enter-from, .tip-leave-to { opacity: 0; transform: translateY(2px); }
.viewer-enter-from, .viewer-leave-to { opacity: 0; transform: scale(0.994); }

@keyframes button-glint { to { transform: translateX(130%); } }
@keyframes parse-orbit { to { transform: rotate(360deg); } }
@keyframes parse-pulse { 50% { transform: translate(-50%, -50%) scale(.72); box-shadow: 0 0 0 14px rgba(60,94,232,.04); } }
@keyframes parse-scan { 0%, 100% { transform: translateY(-24px); opacity: .3; } 50% { transform: translateY(24px); opacity: 1; } }

@media (max-width: 720px) {
  .parse-command { align-items: stretch; flex-direction: column; }
  .parse-action { width: 100%; align-self: auto; }
  .video-result { align-items: stretch; flex-direction: column; }
  .video-stage { height: min(260px, 42vh); max-width: 100%; align-self: center; }
  .result-head { align-items: flex-start; flex-direction: column; }
  .result-actions { width: 100%; margin-left: 0; }
  .result-actions .btn-primary { margin-left: auto; }
}

@media (prefers-reduced-motion: reduce) {
  .parse-core::before, .parse-core-dot, .parse-scanner, .video-pending-orbit { animation: none; }
  .parse-action:hover .parse-action-glint { animation: none; }
}
</style>
