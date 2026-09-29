<script setup>
import { defineAsyncComponent, markRaw, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import ctx from '@/services/ctx'
import { useTools } from '@/tools/registry'

const route = useRoute()
const { byId, refresh } = useTools()

const tool = ref(null)
const mode = ref('') // 'builtin' | 'plugin'
// 组件定义必须 markRaw/shallowRef：放进 ref() 会被做成 reactive，事件和状态会失灵
const view = shallowRef(null)
const pluginBox = ref(null)
const error = ref('')
const loading = ref(false)
const styled = new Set()
let pluginHandle = null

// 宿主的 UnoCSS 只扫得到自己的源码，插件里的类名不会生成样式，所以插件必须自带 CSS。
// 样式现在由插件 JS 自注入；这里只在清单还声明 style 时做兜底。
async function ensureStyle(found) {
  if (!found.style || styled.has(found.id)) return
  styled.add(found.id)
  const url = `toolbox-plugin://${found.id}/${found.style}`
  try {
    const css = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    })
    const el = document.createElement('style')
    el.dataset.pluginStyle = found.id
    el.textContent = css
    document.head.append(el)
  } catch {
    /* 插件 JS 自注入时这里失败可忽略 */
  }
}

function unmountPlugin() {
  try {
    pluginHandle?.unmount?.()
  } catch {
    /* 卸载失败不应挡住切换工具 */
  }
  pluginHandle = null
}

async function resolve(id) {
  loading.value = true
  error.value = ''
  view.value = null
  tool.value = null
  unmountPlugin()
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
      mode.value = 'builtin'
      view.value = markRaw(defineAsyncComponent(found.loader))
      return
    }
    // 插件是独立构建的 ESM 包，自带 Vue，必须用它自己的 createApp 挂载，
    // 否则和宿主两套响应式，点击后状态不刷新。@vite-ignore 防止构建期解析。
    await ensureStyle(found)
    const mod = await import(/* @vite-ignore */ found.entryUrl)
    if (typeof mod.mount !== 'function') {
      // 旧插件兼容：没有 mount 时退回组件模式
      mode.value = 'builtin'
      view.value = markRaw(mod.default)
      return
    }
    mode.value = 'plugin'
    await nextTick()
    if (!pluginBox.value) throw new Error('插件挂载点不存在')
    pluginHandle = mod.mount(pluginBox.value, { ctx })
  } catch (e) {
    mode.value = ''
    error.value = `加载失败：${e.message}`
  } finally {
    loading.value = false
  }
}

watch(() => route.params.id, (id) => resolve(id), { immediate: true })
onBeforeUnmount(unmountPlugin)
</script>

<template>
  <div class="mx-auto max-w-[980px] px-5 py-5">
    <p v-if="loading" class="muted">加载中…</p>
    <div v-else-if="error" class="card border-#f3c9c5 bg-#fdf1f0 p-4 text-danger">
      {{ error }}
    </div>
    <component v-else-if="mode === 'builtin' && view" :is="view" :ctx="ctx" />
    <!-- 常驻 DOM：不能放进 v-if 分支，否则 resolve 期间节点不存在，createApp 挂不上 -->
    <div v-show="mode === 'plugin' && !error" ref="pluginBox" />
  </div>
</template>
