<script setup>
import { defineAsyncComponent, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ctx from '@/services/ctx'
import { useTools } from '@/tools/registry'

const route = useRoute()
const { byId, refresh } = useTools()

const tool = ref(null)
const view = ref(null)
const error = ref('')
const loading = ref(false)
const styled = new Set()

// 宿主的 UnoCSS 只扫得到自己的源码，插件里的类名不会生成样式，所以插件必须自带 CSS，由这里挂上
function ensureStyle(found) {
  if (!found.style || styled.has(found.id)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `toolbox-plugin://${found.id}/${found.style}`
  document.head.append(link)
  styled.add(found.id)
}

async function resolve(id) {
  loading.value = true
  error.value = ''
  view.value = null
  tool.value = null
  try {
    let found = byId(id)
    if (!found) {
      await refresh()
      found = byId(id)
    }
    if (!found) {
      error.value = `没有 id 为 ${id} 的工具`
      return
    }
    tool.value = found
    route.meta.title = found.name
    if (found.source === 'builtin') {
      view.value = defineAsyncComponent(found.loader)
      return
    }
    // 插件是独立构建的 ESM 包，从自定义协议里取；@vite-ignore 防止构建期把它当成本地模块解析
    ensureStyle(found)
    const mod = await import(/* @vite-ignore */ found.entryUrl)
    if (!mod.default) throw new Error('插件入口没有默认导出组件')
    view.value = mod.default
  } catch (e) {
    error.value = `加载失败：${e.message}`
  } finally {
    loading.value = false
  }
}

watch(() => route.params.id, (id) => resolve(id), { immediate: true })
</script>

<template>
  <div class="mx-auto max-w-5xl px-6 py-5">
    <p v-if="loading" class="muted">加载中…</p>
    <div v-else-if="error" class="card border-#f3c9c5 bg-#fdf1f0 p-4 text-danger">
      {{ error }}
    </div>
    <component :is="view" v-else-if="view" :ctx="ctx" />
  </div>
</template>
