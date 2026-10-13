<script setup>
import { ref } from 'vue'
import ctx from '@/services/ctx'

const api = ctx

const file = ref(null) // { path, name, bytes, size }
const result = ref(null) // { bytes, size, warnings }
const busy = ref('')
const err = ref('')
const saved = ref('')
const opts = ref({ pageSize: 'A4', landscape: false })

const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB')

async function pick() {
  const paths = await api.call('dialog:pickFiles', { multiple: false, filters: [{ name: 'Word 文档', extensions: ['docx'] }] })
  if (!paths?.length) return
  const [f] = await api.call('files:read', { filePaths: paths })
  file.value = { path: f.path, name: f.name, bytes: f.data, size: f.data.length }
  result.value = null
  saved.value = ''
  err.value = ''
}

async function run() {
  if (!file.value || busy.value) return
  busy.value = '解析文档'
  err.value = ''
  saved.value = ''
  try {
    const mod = await import('mammoth/mammoth.browser')
    const mammoth = mod.default || mod
    // mammoth 要 ArrayBuffer：IPC 传来的 Uint8Array 得拷一份，不能直接交 .buffer（起点不保证是 0）
    const arrayBuffer = file.value.bytes.slice().buffer
    const { value: body, messages } = await mammoth.convertToHtml({ arrayBuffer })
    busy.value = '生成 PDF'
    const bytes = await api.call('print:htmlToPdf', {
      html: pageHtml(body),
      pageSize: opts.value.pageSize,
      landscape: opts.value.landscape,
    })
    result.value = { bytes, size: bytes.length, warnings: (messages || []).filter((m) => m.type === 'warning') }
  } catch (e) {
    err.value = /docx|zip|end of data|central directory/i.test(e.message)
      ? '无法解析这个文件：只支持 .docx，旧版 .doc 请先在 Word 里「另存为 → .docx」。'
      : e.message
  } finally {
    busy.value = ''
  }
}

/** 打印样式在这里定，主进程只负责出纸；Chromium 用系统字体排中文没有问题 */
function pageHtml(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 12pt; line-height: 1.7; color: #1c1c1c; }
    h1, h2, h3, h4 { line-height: 1.35; margin: 0.9em 0 0.4em; }
    p { margin: 0.5em 0; }
    img { max-width: 100%; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #b9b9b9; padding: 4px 8px; }
    a { color: #2f5dd8; }
  </style></head><body>${body}</body></html>`
}

async function saveOut() {
  if (!result.value) return
  const name = file.value.name.replace(/\.docx$/i, '') + '.pdf'
  const r = await api.call('files:save', { name, data: result.value.bytes })
  if (!r.canceled) saved.value = r.path
}
</script>

<template>
  <div class="stack max-w-[560px]">
    <div class="row">
      <button class="btn-primary" @click="pick"><span class="i-lucide-file-input size-4" />选择 Word 文档</button>
      <span v-if="file" class="muted truncate">{{ file.name }} · {{ kb(file.size) }}</span>
      <span v-else class="muted">只支持 .docx（旧 .doc 需先另存为 .docx）</span>
    </div>

    <div class="card p-4 stack">
      <label class="stack gap-1">
        <span class="label">纸张</span>
        <select v-model="opts.pageSize" class="field">
          <option>A4</option>
          <option>A3</option>
          <option>A5</option>
          <option>Letter</option>
          <option>Legal</option>
        </select>
      </label>
      <label class="row gap-2 text-13px">
        <input v-model="opts.landscape" type="checkbox" />
        <span>横向排版</span>
      </label>
      <p class="muted">标题、段落、列表、表格、图片会保留；分栏、文本框、域代码、批注这类复杂排版会丢。</p>
    </div>

    <div class="row">
      <button class="btn-primary" :disabled="!file || !!busy" @click="run">
        <span v-if="busy" class="i-lucide-loader-2 size-4 animate-spin" />{{ busy || '转换为 PDF' }}
      </button>
      <button v-if="result" class="btn-plain" @click="saveOut">保存结果</button>
    </div>

    <p v-if="err" class="rounded-md border border-#f3d5b3 bg-#fdf6ec px-3 py-2 text-12px text-#8a5a1a">{{ err }}</p>

    <div v-if="result" class="card p-4 stack">
      <div class="row justify-between">
        <span class="title tabular">{{ file.name.replace(/\.docx$/i, '') }}.pdf</span>
        <span class="tabular text-16px font-600 text-ok">{{ kb(result.size) }}</span>
      </div>
      <p class="muted tabular">源文件 {{ kb(file.size) }} → PDF {{ kb(result.size) }}</p>
      <p v-if="result.warnings.length" class="muted">
        有 {{ result.warnings.length }} 处排版没有对应转换（如特殊样式），已按普通段落处理。
      </p>
    </div>

    <p v-if="saved" class="muted break-all data-selectable">已保存：{{ saved }}</p>
  </div>
</template>
