<script setup>
import { onMounted, ref } from 'vue'
import ctx from '@/services/ctx'
import { useTools } from '@/tools/registry'

const api = ctx
const { downloadable, plugins, registryError, refreshing, refresh } = useTools()
const installing = ref('')
const progress = ref({})
const error = ref('')

let off = null

async function install(entry) {
  installing.value = entry.id
  error.value = ''
  off = api.on('plugins:progress', (p) => (progress.value = p))
  try {
    await api.call('plugins:install', { entry })
    await refresh()
  } catch (e) {
    error.value = e.message
  } finally {
    off?.()
    off = null
    installing.value = ''
  }
}

async function uninstall(id) {
  await api.call('plugins:uninstall', { id })
  await refresh()
}

function pct(p) {
  if (!p?.total) return 0
  return Math.round((p.received / p.total) * 100)
}

onMounted(() => {
  refresh()
})
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-5">
    <div v-if="error" class="mb-3 rounded-md border border-#f3c6c2 bg-#fdf1f0 px-3 py-2 text-12px text-#8c2c25">{{ error }}</div>

    <section class="mb-6">
      <div class="mb-2 flex items-center gap-2">
        <h2 class="label">已安装插件</h2>
        <button class="btn-ghost ml-auto h-7" :disabled="refreshing" @click="refresh">
          <span :class="['i-lucide-refresh-cw size-3.5', refreshing ? 'animate-spin' : '']" />重新读取清单
        </button>
      </div>
      <p v-if="!plugins.length" class="muted rounded-md border border-dashed border-surface-line-strong px-3 py-6 text-center">还没有安装过插件</p>
      <ul v-else class="space-y-2">
        <li v-for="p in plugins" :key="p.id" class="card flex items-center gap-3 px-3 py-2">
          <span :class="[p.icon, 'size-4 text-ink-3']" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-13px font-500">{{ p.name }} <span class="muted tabular">v{{ p.version }}</span></span>
            <span class="muted block truncate">{{ p.summary }}</span>
          </span>
          <button class="btn-plain h-7" @click="uninstall(p.id)">卸载</button>
        </li>
      </ul>
    </section>

    <section>
      <h2 class="label mb-2">可下载</h2>
      <p v-if="registryError" class="muted rounded-md border border-#f3d5b3 bg-#fdf6ec px-3 py-2 text-12px text-#8a5a1a">清单加载失败：{{ registryError }}</p>
      <p v-else-if="!downloadable.length" class="muted rounded-md border border-dashed border-surface-line-strong px-3 py-6 text-center">暂时没有可下载的插件（清单为空或都已安装）</p>
      <ul v-else class="space-y-2">
        <li v-for="entry in downloadable" :key="entry.id" class="card flex items-center gap-3 px-3 py-2">
          <span class="flex size-9 flex-none items-center justify-center rounded-md bg-surface-sunken">
            <span :class="[entry.icon || 'i-lucide-puzzle', 'size-4 text-ink-2']" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-13px font-500">{{ entry.name }} <span class="muted tabular">v{{ entry.version }} · {{ (entry.size / 1048576).toFixed(1) }} MB</span></span>
            <span class="muted block truncate">{{ entry.summary }}</span>
            <span v-if="installing === entry.id && progress.total" class="mt-1 block h-1 overflow-hidden rounded bg-surface-sunken">
              <span class="block h-full bg-accent transition-[width] duration-200" :style="{ width: pct(progress) + '%' }" />
            </span>
          </span>
          <button class="btn-primary h-7" :disabled="!!installing" @click="install(entry)">
            <span v-if="installing === entry.id" class="i-lucide-loader-2 size-3.5 animate-spin" />
            {{ installing === entry.id ? pct(progress) + '%' : '下载并安装' }}
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
