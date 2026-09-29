<script setup>
import { onMounted, ref } from 'vue'
import ctx from '@/services/ctx'

const api = ctx
const settings = ref(null)
const appInfo = ref(null)
const saved = ref('')

const STRATEGIES = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'seo', label: '仅 SEO 直连（只支持图文）' },
  { value: 'demoApi', label: '仅解析接口' },
  { value: 'nologo', label: '仅备用接口' },
]

onMounted(async () => {
  settings.value = await api.call('settings:get')
  appInfo.value = await api.call('app:info')
})

async function patch(next, message = '已保存') {
  settings.value = await api.call('settings:set', next)
  saved.value = message
}

async function pickFolder() {
  const dir = await api.call('dialog:pickFolder', { defaultPath: settings.value.downloadDir })
  if (dir) await patch({ downloadDir: dir }, '下载目录已更新')
}

async function resetAll() {
  if (!window.confirm('恢复默认设置会清掉解析接口地址和备用 token，确定吗？')) return
  settings.value = await api.call('settings:reset')
  saved.value = '已恢复默认'
}
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-5">
    <div v-if="saved" class="mb-3 flex items-center gap-2 rounded-md border border-#b7e3cc bg-#effaf3 px-3 py-2 text-12px text-#1c6b40">
      <span class="i-lucide-check size-3.5" /><span>{{ saved }}</span>
      <button class="i-lucide-x ml-auto size-3.5 text-ink-3" @click="saved = ''" />
    </div>

    <div v-if="settings" class="space-y-4">
      <section class="card p-4">
        <div class="label mb-2">解析链路说明</div>
        <p class="text-12px leading-6 text-ink-2">
          图文走 SEO 直连：不经过任何第三方，但只覆盖图文作品。视频必须走解析接口，因为视频页面里不含直链。
          备用接口按次计费，只在填了 token 时启用。改动立即对新一次解析生效，已解析出的结果不受影响。
        </p>
      </section>

      <section class="card p-4">
        <div class="label mb-3">下载</div>
        <div class="flex items-center gap-2">
          <span class="field flex min-w-0 flex-1 items-center truncate" data-selectable>{{ settings.downloadDir }}</span>
          <button class="btn-plain" @click="pickFolder">选择目录</button>
        </div>
        <p class="muted mt-2">解析结果、生成的 PDF 都落在这个目录下的日期子目录里。</p>
      </section>

      <section class="card p-4">
        <div class="label mb-3">在线解析</div>
        <label class="mb-3 block">
          <span class="label mb-1 block">链路策略</span>
          <select class="field w-full" :value="settings.parseStrategy" @change="patch({ parseStrategy: $event.target.value }, '解析策略已更新')">
            <option v-for="s in STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <label class="mb-3 block">
          <span class="label mb-1 block">解析接口地址</span>
          <input class="field w-full" :value="settings.demoApiHost" data-selectable @change="patch({ demoApiHost: $event.target.value })" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label mb-1 block">备用接口地址</span>
            <input class="field w-full" :value="settings.nologoEndpoint" data-selectable @change="patch({ nologoEndpoint: $event.target.value })" />
          </label>
          <label class="block">
            <span class="label mb-1 block">备用接口 token</span>
            <input class="field w-full" :value="settings.nologoToken" type="password" @change="patch({ nologoToken: $event.target.value })" />
          </label>
        </div>
      </section>

      <section class="card p-4">
        <div class="label mb-3">插件</div>
        <label class="block">
          <span class="label mb-1 block">插件清单地址</span>
          <input class="field w-full" :value="settings.pluginRegistryUrl" data-selectable @change="patch({ pluginRegistryUrl: $event.target.value })" />
        </label>
        <label class="mt-3 block">
          <span class="label mb-1 block">模型包源地址（留空用登记的 Release 地址）</span>
          <input class="field w-full" :value="settings.modelBaseUrl" placeholder="http://127.0.0.1:8000/dist-models" data-selectable @change="patch({ modelBaseUrl: $event.target.value })" />
        </label>
        <p class="muted mt-2">清单是发布在 Release 上的 plugins.json，安装时会校验其中声明的 SHA-256。<span class="text-danger">注意：私有仓库的 Release 资产需要登录鉴权，未登录会 404</span>——要对外分发得把仓库转公开，或换境外对象存储并把地址填到这里。</p>
      </section>

      <section class="card p-4">
        <div class="label mb-3">更新</div>
        <label class="mb-3 flex items-center gap-2 text-12px">
          <input type="checkbox" :checked="settings.autoCheckUpdate" @change="patch({ autoCheckUpdate: $event.target.checked }, '启动时自动检查已更新')" />
          启动时自动检查更新
        </label>
        <label class="block">
          <span class="label mb-1 block">更新源目录（留空用 GitHub Releases）</span>
          <input class="field w-full" :value="settings.updateFeedUrl" placeholder="https://&lt;bucket&gt;.cos.ap-seoul.myqcloud.com/upgrade/win/" data-selectable @change="patch({ updateFeedUrl: $event.target.value })" />
        </label>
        <p class="muted mt-2">填目录地址即改走 generic provider，要求 <span class="font-mono">latest.yml</span> 与安装包同目录；将来换成境外对象存储只改这一栏。</p>
        <button class="btn-plain mt-3" @click="api.call('update:check')">立即检查</button>
        <span class="muted ml-2">结果显示在左下角</span>
      </section>

      <section class="card p-4">
        <div class="label mb-2">关于</div>
        <ul v-if="appInfo" class="muted tabular space-y-1" data-selectable>
          <li>版本 {{ appInfo.version }} · Electron {{ appInfo.electron }} · Chromium {{ appInfo.chrome }} · Node {{ appInfo.node }}</li>
          <li class="break-all">数据目录 {{ appInfo.userData }}</li>
          <li class="break-all">插件目录 {{ appInfo.pluginRoot }}</li>
        </ul>
        <button class="btn-plain mt-3" @click="resetAll">恢复默认设置</button>
      </section>
    </div>
  </div>
</template>
