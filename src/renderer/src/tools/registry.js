import { computed, ref } from 'vue'
import ctx from '@/services/ctx'

/**
 * 内置工具随宿主一起打包，永远可用；插件工具由主进程从 userData 下扫描得到。
 * 两者的描述字段对齐 manifest，UI 层不需要知道工具来自哪里。
 */
export const BUILTIN_TOOLS = [
  {
    id: 'douyin-parse',
    name: '在线解析',
    summary: '粘贴抖音分享口令，取回无水印原图与视频',
    icon: 'i-lucide-downloads',
    category: '媒体',
    source: 'builtin',
    status: 'ready',
    capabilities: ['douyin:parse', 'media:save', 'shell:openPath', 'clipboard:readText'],
    loader: () => import('@/tools/douyin/Index.vue'),
  },
  {
    id: 'img-to-pdf',
    name: '图片转 PDF',
    summary: '多张图片合成一个 PDF，可选纸张、边距与排列',
    icon: 'i-lucide-file-plus',
    category: '文档',
    source: 'builtin',
    status: 'ready',
    capabilities: ['dialog:pickFiles', 'files:read', 'files:save'],
    loader: () => import('@/tools/img-pdf/Index.vue'),
  },
]

const plugins = ref([])
const remote = ref([])
const registryError = ref('')
const refreshing = ref(false)

function fromManifest(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    summary: m.summary || m.description || '',
    // 插件自带样式表（宿主构建时扫不到插件里的原子类，所以插件必须自带 CSS）
    style: m.style || '',
    icon: m.icon || 'i-lucide-puzzle',
    category: m.category || '插件',
    source: 'plugin',
    status: m.broken ? 'broken' : m.entryExists ? 'ready' : 'broken',
    version: m.version || '',
    entryUrl: `toolbox-plugin://${m.id}/${m.entry || 'dist/index.js'}`,
    capabilities: m.capabilities || [],
    note: m.broken || '',
  }
}

export async function refresh() {
  refreshing.value = true
  registryError.value = ''
  try {
    plugins.value = (await ctx.call('plugins:list')).map(fromManifest)
    try {
      const { plugins: list, stale } = await ctx.call('plugins:registry')
      remote.value = list
      if (stale) registryError.value = '插件市场暂时离线，正在显示上次成功加载的清单；已安装工具不受影响'
    } catch (e) {
      registryError.value = e.message || '插件市场暂时无法连接；已安装工具不受影响'
    }
  } finally {
    refreshing.value = false
  }
}

export function useTools() {
  const installedIds = computed(() => new Set([...BUILTIN_TOOLS.map((t) => t.id), ...plugins.value.map((p) => p.id)]))
  const tools = computed(() => [...BUILTIN_TOOLS, ...plugins.value])
  const downloadable = computed(() => remote.value.filter((p) => !installedIds.value.has(p.id)))
  const byId = (id) => tools.value.find((t) => t.id === id)
  return { tools, downloadable, byId, plugins, remote, registryError, refreshing, refresh }
}
