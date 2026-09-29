<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useTools } from '@/tools/registry'

const router = useRouter()
const { tools, refresh, refreshing } = useTools()
const keyword = ref('')

const grouped = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const match = (t) => !kw || t.name.toLowerCase().includes(kw) || t.summary.toLowerCase().includes(kw)
  const byCategory = new Map()
  for (const tool of tools.value.filter(match)) {
    const list = byCategory.get(tool.category) || []
    list.push(tool)
    byCategory.set(tool.category, list)
  }
  return [...byCategory.entries()].map(([category, items]) => ({ category, items }))
})

const cardCount = computed(() => grouped.value.reduce((n, g) => n + g.items.length, 0))

function open(tool) {
  if (tool.status !== 'ready') return
  router.push({ name: 'tool', params: { id: tool.id } })
}

onMounted(() => refresh())
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-5">
    <div class="mb-4 flex items-center gap-3">
      <div class="relative flex-1">
        <span class="i-lucide-search pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-4" />
        <input v-model="keyword" class="field w-full pl-8" placeholder="搜索工具" data-selectable />
      </div>
      <button class="btn-plain" :disabled="refreshing" @click="refresh">
        <span :class="['i-lucide-refresh-cw size-3.5', refreshing ? 'animate-spin' : '']" />刷新插件
      </button>
    </div>

    <section v-for="(group, gi) in grouped" :key="group.category" class="mb-6">
      <h2 class="label mb-2">{{ group.category }}</h2>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-2.5">
        <li v-for="(tool, ti) in group.items" :key="tool.id" :style="{ '--d': `${gi * 40 + ti * 30}ms` }" class="tool-enter">
          <button
            class="card group flex h-full w-full items-start gap-3 p-3 text-left transition-[background-color,border-color,transform] duration-150"
            :class="tool.status === 'ready' ? 'hover:border-surface-line-strong hover:bg-#fbfcfd active:translate-y-px' : 'cursor-default opacity-70'"
            @click="open(tool)"
          >
            <span class="flex size-9 flex-none items-center justify-center rounded-md bg-surface-sunken text-ink-2 transition-colors duration-150 group-hover:bg-accent-soft group-hover:text-accent">
              <span :class="[tool.icon, 'size-4.5']" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="truncate text-14px font-600">{{ tool.name }}</span>
                <span
                  v-if="tool.source === 'plugin'"
                  class="h-4 flex-none rounded bg-surface-sunken px-1 text-10px leading-4 text-ink-3 tabular"
                  >插件 v{{ tool.version }}</span
                >
                <span v-else-if="tool.status === 'coming'" class="h-4 flex-none rounded bg-#fff4e5 px-1 text-10px leading-4 text-warn">准备中</span>
              </span>
              <span class="mt-1 block text-12px leading-5 text-ink-3">{{ tool.summary }}</span>
              <span v-if="tool.note" class="mt-1 block text-12px text-danger">{{ tool.note }}</span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <p v-if="!cardCount" class="muted py-10 text-center">没有匹配的工具</p>
  </div>
</template>

<style scoped>
/* 进场只做「存在」的提示，位移 6px、时长 180ms；卡片本身要立刻可读，不做淡入延迟 */
.tool-enter {
  animation: tool-in 180ms ease-out backwards;
  animation-delay: var(--d, 0ms);
}

@keyframes tool-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
</style>
