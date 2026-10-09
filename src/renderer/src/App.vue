<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ctx from '@/services/ctx'
import { BUILTIN_TOOLS, refresh, useTools } from '@/tools/registry'

const route = useRoute()
const router = useRouter()
const { plugins } = useTools()

const appInfo = ref(null)
const update = ref({ state: 'idle', message: '' })
const nav = [
  { to: '/', label: '全部工具', icon: 'i-lucide-layout-grid' },
  { to: '/plugins', label: '插件', icon: 'i-lucide-puzzle' },
  { to: '/settings', label: '设置', icon: 'i-lucide-settings' },
]

const UPDATE_LABEL = { checking: '检查中', available: '发现新版本', downloading: '下载中', downloaded: '已下载', error: '检查失败' }

const title = computed(() => route.meta?.title || '工具箱')
const quickTools = computed(() => [...BUILTIN_TOOLS, ...plugins.value])

async function updateAction(action) {
  await ctx.call(`update:${action}`).catch(() => {})
}

onMounted(async () => {
  appInfo.value = await ctx.call('app:info').catch(() => null)
  await refresh()
  ctx.on('update:status', (payload) => (update.value = payload))
  const settings = await ctx.call('settings:get').catch(() => null)
  // 只在启动后静默查一次；失败不打扰用户，状态留在提示条里等他自己看
  if (settings?.autoCheckUpdate) ctx.call('update:check').catch(() => {})
})

function goTool(tool) {
  if (tool.status !== 'ready') return
  router.push({ name: 'tool', params: { id: tool.id } })
}
</script>

<template>
  <div class="app-shell flex h-full text-ink-1">
    <aside data-chrome class="app-sidebar flex-none flex flex-col border-r border-surface-line">
      <div class="drag titlebar-reserve sidebar-brand flex h-16 items-center gap-3 px-4">
        <span class="flex size-8 items-center justify-center rounded-lg bg-accent text-white shadow-[0_0_0_4px_rgba(60,94,232,0.12)]">
          <span class="i-lucide-sparkles size-4.5" />
        </span>
        <span class="sidebar-wordmark min-w-0">
          <span class="block text-13px font-700 tracking-[0.08em]">TOOLBOX</span>
          <span class="block text-10px tracking-[0.16em] text-ink-4">PERSONAL WORKBENCH</span>
        </span>
      </div>

      <nav class="px-3 py-4">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="sidebar-nav-link flex h-10 items-center gap-3 rounded-lg px-3 text-13px text-ink-2 transition-colors duration-150 hover:bg-surface-sunken hover:text-ink-1"
          :class="route.path === item.to ? 'bg-accent-soft text-accent font-600 hover:bg-accent-soft hover:text-accent' : ''"
        >
          <span :class="[item.icon, 'size-4']" />
          <span class="sidebar-nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="mt-1 flex-1 overflow-y-auto px-3 pb-3">
        <div class="sidebar-nav-label px-3 py-2 text-10px font-600 tracking-[0.16em] text-ink-4">已安装工具</div>
        <button
          v-for="tool in quickTools"
          :key="tool.id"
          class="sidebar-tool no-drag flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-12px transition-colors duration-150"
          :class="[
            route.params.id === tool.id ? 'bg-surface-sunken text-ink-1 font-500' : 'text-ink-2 hover:bg-surface-sunken hover:text-ink-1',
            tool.status !== 'ready' ? 'opacity-40 cursor-default' : '',
          ]"
          :disabled="tool.status !== 'ready'"
          @click="goTool(tool)"
        >
          <span :class="[tool.icon, 'size-4 text-accent']" />
          <span class="sidebar-tool-name truncate">{{ tool.name }}</span>
        </button>
      </div>

      <footer class="flex-none border-t border-surface-line px-3 py-3">
        <Transition name="tip">
          <div v-if="update.state !== 'idle'" class="mb-3 rounded-lg border border-surface-line bg-surface-raised px-3 py-2">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-11px text-ink-2">{{ UPDATE_LABEL[update.state] || update.state }}{{ update.message ? ' · ' + update.message : '' }}</span>
              <button v-if="update.state === 'available'" class="btn-primary ml-auto h-6 px-2 text-11px" @click="updateAction('download')">下载</button>
              <button v-if="update.state === 'downloaded'" class="btn-primary ml-auto h-6 px-2 text-11px" @click="updateAction('install')">重启安装</button>
              <button v-if="update.state === 'error'" class="btn-ghost ml-auto h-6 px-2 text-11px" @click="updateAction('releasePage')">下载页</button>
            </div>
            <div v-if="update.state === 'downloading'" class="mt-2 h-1 overflow-hidden rounded bg-surface-sunken">
              <span class="block h-full w-full origin-left bg-accent transition-transform duration-150" :style="{ transform: `scaleX(${(update.percent || 0) / 100})` }" />
            </div>
          </div>
        </Transition>
        <div class="sidebar-footer-copy muted no-drag flex items-center justify-between px-1">
          <span>v{{ appInfo?.version || '0.1.0' }}</span>
          <span class="uppercase">{{ appInfo?.platform }}</span>
        </div>
      </footer>
    </aside>

    <main class="app-main flex min-w-0 flex-1 flex-col">
      <header data-chrome class="drag flex h-14 flex-none items-center gap-3 border-b border-surface-line/80 bg-surface-base/85 px-[clamp(16px,3vw,36px)] backdrop-blur-sm">
        <span class="text-12px font-700 tracking-[0.14em] text-ink-3">{{ title === '全部工具' ? 'WORKBENCH' : title }}</span>
        <span class="no-drag ml-auto flex items-center gap-2">
          <RouterLink to="/" class="btn-ghost h-8 text-12px" :class="route.name === 'home' ? 'invisible' : ''">
            <span class="i-lucide-arrow-left size-3.5" />返回工作台
          </RouterLink>
        </span>
      </header>

      <div class="app-content min-h-0 flex-1">
        <RouterView v-slot="{ Component }">
          <Transition name="view" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* 切工具是高频动作，只做 4px 位移 + 淡入；出场比入场快两成，避免等它 */
.view-enter-active {
  transition:
    opacity var(--m-micro) var(--m-enter),
    transform var(--m-micro) var(--m-enter);
}

.view-leave-active {
  transition:
    opacity 90ms var(--m-enter),
    transform 90ms var(--m-enter);
}

.view-enter-from,
.view-leave-to {
  opacity: 0;
  transform: translateY(var(--m-shift));
}

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
</style>
