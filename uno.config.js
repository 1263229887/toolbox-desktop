import { defineConfig, presetUno, presetIcons, transformerDirectives, transformerVariantGroup } from 'unocss'

/**
 * 颜色与尺寸一律指向 tokens.css 里的 CSS 变量：
 * 类名保持不变（bg-surface-raised 等），但真实取值只有一个来源，
 * 插件用 var(--tb-*) 也能拿到同一套值。
 */
const c = (name) => `var(--tb-${name})`

export default defineConfig({
  presets: [
    presetUno(),
    presetIcons({
      scale: 1.1,
      warn: true,
      extraProperties: { display: 'inline-block', 'vertical-align': 'middle' },
    }),
  ],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    colors: {
      surface: { base: c('surface-base'), raised: c('surface-raised'), sunken: c('surface-sunken'), hover: c('surface-hover'), line: c('line'), 'line-strong': c('line-strong') },
      ink: { 1: c('ink-1'), 2: c('ink-2'), 3: c('ink-3'), 4: c('ink-4') },
      accent: { DEFAULT: c('accent'), hover: c('accent-hover'), soft: c('accent-soft') },
      ok: c('ok'),
      warn: c('warn'),
      danger: c('danger'),
    },
    fontFamily: {
      sans: '-apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    },
  },
  // 插件 manifest 里的图标类名宿主扫不到，需要显式保留
  safelist: ['i-lucide-puzzle', 'i-lucide-minimize-2', 'i-lucide-eraser', 'i-lucide-file-image', 'i-lucide-scissors', 'i-lucide-image'],
  shortcuts: [
    ['card', `bg-surface-raised border border-surface-line rounded-[6px]`],
    ['panel', 'card shadow-sm'],
    ['overlay-panel', 'card shadow-[var(--tb-shadow-overlay)]'],
    ['stack', 'flex flex-col gap-[var(--tb-space-3)]'],
    ['row', 'flex items-center gap-[var(--tb-space-2)]'],
    ['page', 'mx-auto max-w-[860px] px-[var(--tb-space-5)] py-[var(--tb-space-5)]'],
    ['btn-base', `inline-flex items-center justify-center gap-1.5 h-[var(--tb-h-md)] px-[var(--tb-space-3)] rounded-[var(--tb-radius-md)] text-[13px] font-500 select-none transition-[background-color,color,border-color,transform,box-shadow] duration-[var(--m-micro)] ease active:scale-[0.98] disabled:(opacity-45 cursor-not-allowed active:scale-100)`],
    ['btn-primary', 'btn-base bg-accent text-white hover:bg-accent-hover'],
    ['btn-plain', 'btn-base bg-surface-sunken text-ink-1 border border-surface-line hover:bg-surface-hover'],
    ['btn-ghost', 'btn-base text-ink-2 hover:bg-surface-sunken hover:text-ink-1'],
    ['btn-lg', 'btn-base h-[var(--tb-h-lg)] text-[14px]'],
    ['field', `h-[var(--tb-h-md)] px-[var(--tb-space-2)] rounded-[var(--tb-radius-md)] border border-surface-line-strong bg-surface-raised text-[13px] text-ink-1 outline-none focus:(border-accent shadow-[var(--tb-focus)])`],
    ['label', 'text-[var(--tb-fs-secondary)] text-ink-3 font-500'],
    ['muted', 'text-[var(--tb-fs-secondary)] text-ink-3'],
    ['caption', 'text-[var(--tb-fs-caption)] text-ink-4'],
    ['title', 'text-[var(--tb-fs-title)] font-600 text-ink-1'],
  ],
})
