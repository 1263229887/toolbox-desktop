<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ctx from '@/services/ctx'
import { BUILTIN_TOOLS, refresh, useTools } from '@/tools/registry'

const route = useRoute()
const router = useRouter()
const { plugins } = useTools()

const appInfo = ref(null)
const nav = [
  { to: '/', label: '全部工具', icon: 'i-lucide-layout-grid' },
  { to: '/plugins', label: '插件', icon: 'i-lucide-puzzle' },
  { to: '/settings', label: '设置', icon: 'i-lucide-settings' },
]

const title = computed(() => route.meta?.title || '工具箱')
const quickTools = computed(() => [...BUILTIN_TOOLS, ...plugins.value])

onMounted(async () => {
  appInfo.value = await ctx.call('app:info').catch(() => null)
  await refresh()
})

function goTool(tool) {
  if (tool.status !== 'ready') return
  router.push({ name: 'tool', params: { id: tool.id } })
}
</script>

<template>
  <div class="flex h-full bg-surface-base text-ink-1">
    <aside data-chrome class="w-58 flex-none flex flex-col border-r border-surface-line bg-surface-sunken">
      <div class="drag titlebar-reserve flex h-11 items-center gap-2 px-3">
        <span class="text-13px font-600 tracking-wide">工具箱</span>
        <span class="muted tabular">{{ appInfo ? 'v' + appInfo.version : '' }}</span>
      </div>

      <nav class="px-2 py-1">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-13px text-ink-2 transition-colors duration-150 hover:bg-#e6e9ee hover:text-ink-1"
          :class="route.path === item.to ? 'bg-accent-soft text-accent font-500' : ''"
        >
          <span :class="[item.icon, 'size-4']" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        <div class="label px-2.5 py-1.5">已安装</div>
        <button
          v-for="tool in quickTools"
          :key="tool.id"
          class="no-drag flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-13px transition-colors duration-150"
          :class="[
            route.params.id === tool.id ? 'bg-surface-raised text-ink-1 font-500 shadow-xs' : 'text-ink-2 hover:bg-#e6e9ee hover:text-ink-1',
            tool.status !== 'ready' ? 'opacity-50 cursor-default' : '',
          ]"
          :disabled="tool.status !== 'ready'"
          @click="goTool(tool)"
        >
          <span :class="[tool.icon, 'size-4 text-ink-3']" />
          <span class="truncate">{{ tool.name }}</span>
        </button>
      </div>

      <footer class="muted no-drag flex items-center justify-between px-3 py-2">
        <span>Electron {{ appInfo?.electron }}</span>
        <span>{{ appInfo?.platform }}</span>
      </footer>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col">
      <header data-chrome class="drag flex h-11 flex-none items-center gap-3 border-b border-surface-line bg-surface-raised px-4">
        <span class="text-14px font-600">{{ title }}</span>
        <span class="no-drag ml-auto flex items-center gap-2">
          <RouterLink to="/" class="btn-ghost h-7 text-12px" :class="route.name === 'home' ? 'invisible' : ''">
            <span class="i-lucide-arrow-left size-3.5" />全部工具
          </RouterLink>
        </span>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto">
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
/* 视图切换只动透明度和 4px 位移：范围足够被感知，又不会让密集表格读起来跳 */
.view-enter-active,
.view-leave-active {
  transition:
    opacity 130ms ease-out,
    transform 130ms ease-out;
}

.view-enter-from,
.view-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
