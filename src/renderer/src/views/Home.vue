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
  let order = 0
  for (const tool of tools.value.filter(match)) {
    const list = byCategory.get(tool.category) || []
    list.push({ ...tool, delay: Math.min(order++ * 40, 200) })
    byCategory.set(tool.category, list)
  }
  return [...byCategory.entries()].map(([category, items]) => ({ category, items }))
})

const cardCount = computed(() => grouped.value.reduce((n, g) => n + g.items.length, 0))
const installedCount = computed(() => tools.value.filter((tool) => tool.status === 'ready').length)

function open(tool) {
  if (tool.status !== 'ready') return
  router.push({ name: 'tool', params: { id: tool.id } })
}

onMounted(() => refresh())
</script>

<template>
  <div class="home-page mx-auto w-full max-w-[1180px] px-[clamp(16px,4vw,52px)] py-[clamp(22px,5vw,56px)]">
    <section class="home-hero">
      <div class="home-hero-copy">
        <div class="home-kicker"><span class="home-kicker-dot" />PERSONAL WORKBENCH</div>
        <h1>把琐碎的事，<br /><em>交给工具。</em></h1>
        <p>一个安静、快速、尽量离线的个人工具箱。打开即用，做完即走。</p>
      </div>
      <div class="home-hero-mark" aria-hidden="true">
        <span class="i-lucide-command size-12" />
        <span class="home-hero-ring ring-one" />
        <span class="home-hero-ring ring-two" />
      </div>
    </section>

    <section class="home-toolbar" aria-label="工具搜索">
      <div class="home-search">
        <span class="i-lucide-search pointer-events-none size-4 text-ink-3" />
        <input v-model="keyword" placeholder="搜索工具或动作" data-selectable />
        <kbd>⌘ K</kbd>
      </div>
      <button class="home-refresh" :disabled="refreshing" @click="refresh">
        <span :class="['i-lucide-refresh-cw size-3.5', refreshing ? 'animate-spin' : '']" />
        <span>刷新插件</span>
      </button>
    </section>

    <section class="home-stats" aria-label="工具箱状态">
      <div><strong>{{ installedCount }}</strong><span>已安装工具</span></div>
      <div><strong>LOCAL</strong><span>优先本地运行</span></div>
      <div><strong>READY</strong><span>随时可以开始</span></div>
      <span class="home-stats-line" />
    </section>

    <div class="home-section-head">
      <div>
        <span class="home-section-kicker">YOUR TOOLKIT</span>
        <h2>现在就开始</h2>
      </div>
      <span class="home-count tabular">{{ cardCount.toString().padStart(2, '0') }} tools</span>
    </div>

    <section v-for="group in grouped" :key="group.category" class="home-group">
      <h3>{{ group.category }}</h3>
      <ul class="home-grid">
        <li v-for="tool in group.items" :key="tool.id" :style="{ '--d': `${tool.delay}ms` }" class="tool-enter">
          <button
            class="home-tool-card group flex h-full w-full flex-col p-4 text-left transition-[background-color,border-color,transform] duration-150"
            :class="tool.status === 'ready' ? 'hover:-translate-y-0.5 hover:border-ink-3 active:translate-y-0' : 'cursor-default opacity-65'"
            @click="open(tool)"
          >
            <span class="home-tool-top">
              <span class="home-tool-icon" :class="tool.source === 'plugin' ? 'is-plugin' : ''"><span :class="[tool.icon, 'size-5']" /></span>
              <span v-if="tool.source === 'plugin'" class="home-tool-badge">PLUGIN</span>
              <span v-else class="home-tool-arrow i-lucide-arrow-up-right size-4" />
            </span>
            <span class="home-tool-copy mt-5 min-w-0">
              <span class="block truncate text-16px font-650 tracking-[-0.01em]">{{ tool.name }}</span>
              <span class="mt-1.5 block text-12px leading-5 text-ink-2">{{ tool.summary }}</span>
            </span>
            <span class="home-tool-meta mt-3 flex items-center gap-2 text-10px tracking-[0.08em] text-ink-4"><span class="home-meta-line" />{{ tool.status === 'ready' ? 'OPEN TOOL' : 'COMING SOON' }}</span>
          </button>
        </li>
      </ul>
    </section>

    <p v-if="!cardCount" class="muted py-10 text-center">没有匹配的工具</p>
  </div>
</template>

<style scoped>
.home-hero { display: flex; min-height: 168px; align-items: flex-end; justify-content: space-between; gap: 24px; padding-bottom: 24px; }
.home-kicker, .home-section-kicker { display: flex; align-items: center; gap: 8px; color: var(--tb-ink-3); font-size: 10px; font-weight: 700; letter-spacing: 0.16em; }
.home-kicker-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tb-accent); box-shadow: 0 0 0 4px var(--tb-accent-soft); }
.home-hero h1 { margin-top: 12px; color: var(--tb-ink-1); font-size: clamp(30px, 3.4vw, 42px); font-weight: 700; letter-spacing: -0.035em; line-height: 1.02; }
.home-hero h1 em { color: var(--tb-ink-2); font-style: normal; }
.home-hero p { max-width: 420px; margin-top: 12px; color: var(--tb-ink-3); font-size: 12px; }
.home-hero-mark { position: relative; display: grid; width: 108px; height: 108px; place-items: center; flex: none; overflow: hidden; border: 1px solid rgba(60, 94, 232, 0.6); border-radius: 50%; color: var(--tb-accent); background: rgba(229, 234, 255, 0.72); transform: rotate(8deg); animation: hero-float 5s ease-in-out infinite; }
.home-hero-mark > .i-lucide-command { width: 25px; height: 25px; }
.home-hero-ring { position: absolute; border: 1px solid rgba(60, 94, 232, 0.25); border-radius: 50%; }
.ring-one { width: 72px; height: 72px; animation: hero-orbit 9s linear infinite; }
.ring-two { width: 132px; height: 132px; animation: hero-orbit 13s linear infinite reverse; }
.home-toolbar { display: flex; gap: 10px; align-items: center; padding: 7px; border: 1px solid var(--tb-line); border-radius: 12px; background: rgba(255, 255, 255, 0.88); box-shadow: 0 10px 24px rgba(32, 45, 72, 0.055); transition: border-color var(--m-standard), box-shadow var(--m-standard); }
.home-toolbar:focus-within { border-color: rgba(60, 94, 232, 0.52); box-shadow: 0 0 0 3px var(--tb-accent-soft), 0 12px 26px rgba(32, 45, 72, 0.07); }
.home-search { display: flex; min-width: 0; flex: 1; align-items: center; gap: 10px; padding: 0 10px; }
.home-search input { min-width: 0; flex: 1; height: 36px; color: var(--tb-ink-1); font-size: 13px; }
.home-search input::placeholder { color: var(--tb-ink-4); }
.home-search kbd { border: 1px solid var(--tb-line); border-radius: 5px; padding: 2px 6px; color: var(--tb-ink-3); background: var(--tb-surface-sunken); font-size: 10px; white-space: nowrap; }
.home-refresh { display: inline-flex; height: 36px; align-items: center; gap: 7px; flex: none; border-radius: 8px; padding: 0 12px; color: var(--tb-ink-1); background: var(--tb-surface-sunken); font-size: 12px; font-weight: 600; }
.home-refresh:hover { background: var(--tb-surface-hover); }
.home-refresh:disabled { opacity: 0.5; }
.home-stats { position: relative; display: flex; gap: clamp(20px, 5vw, 62px); align-items: center; padding: 20px 4px 26px; }
.home-stats div { display: grid; gap: 2px; }
.home-stats strong { color: var(--tb-ink-1); font-size: 17px; letter-spacing: 0.04em; }
.home-stats span:not(.home-stats-line) { color: var(--tb-ink-3); font-size: 10px; }
.home-stats-line { width: 1px; height: 30px; margin-left: auto; background: var(--tb-line); }
.home-section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--tb-line); }
.home-section-head h2 { margin-top: 7px; font-size: 23px; font-weight: 650; letter-spacing: -0.02em; }
.home-count { color: var(--tb-ink-3); font-size: 11px; }
.home-group { padding-top: 24px; }
.home-group h3 { margin-bottom: 10px; color: var(--tb-ink-3); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.home-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 12px; }
.home-tool-card { position: relative; min-height: 164px; overflow: hidden; border: 1px solid var(--tb-line); border-radius: 12px; background: rgba(255, 255, 255, 0.86); box-shadow: 0 3px 0 rgba(23, 34, 55, 0.025); }
.home-tool-card::after { position: absolute; inset: 0; content: ''; pointer-events: none; background: linear-gradient(105deg, transparent 30%, rgba(60, 94, 232, 0.07), transparent 70%); transform: translateX(-120%); transition: transform 520ms var(--m-enter); }
.home-tool-card:hover { background: var(--tb-surface-raised); box-shadow: 0 10px 22px rgba(32, 45, 72, 0.075); }
.home-tool-card:hover::after { transform: translateX(120%); }
.home-tool-top { display: flex; align-items: center; justify-content: space-between; }
.home-tool-icon { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--tb-line); border-radius: 9px; color: var(--tb-accent); background: var(--tb-accent-soft); }
.home-tool-icon > span { width: 17px; height: 17px; }
.home-tool-icon.is-plugin { color: var(--tb-nav-ink); background: var(--tb-nav); }
.home-tool-badge { color: var(--tb-ink-4); font-size: 9px; font-weight: 700; letter-spacing: 0.1em; }
.home-tool-arrow { color: var(--tb-ink-4); }
.home-tool-meta { margin-top: auto; }
.home-meta-line { width: 18px; height: 1px; background: var(--tb-accent); }
.tool-enter { animation: tool-in var(--m-standard) var(--m-enter) backwards; animation-delay: var(--d, 0ms); }
@keyframes tool-in { from { opacity: 0; transform: translateY(var(--m-shift)); } }
@keyframes hero-float { 0%, 100% { transform: rotate(8deg) translateY(0); } 50% { transform: rotate(11deg) translateY(-4px); } }
@keyframes hero-orbit { to { transform: rotate(360deg); } }

@media (max-width: 760px) {
  .home-hero { min-height: 0; align-items: flex-start; padding-bottom: 24px; }
  .home-hero-mark { width: 88px; height: 88px; }
  .home-hero-mark > .i-lucide-command { width: 24px; height: 24px; }
  .home-hero-ring.ring-one { width: 60px; height: 60px; }
  .home-hero-ring.ring-two { width: 110px; height: 110px; }
  .home-hero p { max-width: 300px; }
  .home-stats { gap: 18px; padding-top: 22px; }
  .home-stats-line { display: none; }
}
@media (max-width: 520px) {
  .home-hero-mark { display: none; }
  .home-toolbar { align-items: stretch; flex-direction: column; }
  .home-refresh { justify-content: center; }
  .home-stats { justify-content: space-between; }
  .home-stats strong { font-size: 14px; }
  .home-stats span:not(.home-stats-line) { font-size: 9px; }
}

@media (prefers-reduced-motion: reduce) {
  .home-hero-mark, .home-hero-ring { animation: none; }
  .home-tool-card::after { display: none; }
}
</style>
