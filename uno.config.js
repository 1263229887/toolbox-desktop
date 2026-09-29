import { defineConfig, presetUno, presetIcons, transformerDirectives, transformerVariantGroup } from 'unocss'

// 桌面工具箱：信息密度优先，色彩克制。状态色只用在真正承载语义的元素上。
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
  // 插件的图标类名写在 manifest.json 里，宿主构建时扫不到，需要显式保留
  safelist: ['i-lucide-puzzle', 'i-lucide-minimize-2', 'i-lucide-eraser', 'i-lucide-file-image', 'i-lucide-scissors'],
  theme: {
    colors: {
      surface: {
        base: '#f7f8fa',
        raised: '#ffffff',
        sunken: '#eef0f3',
        line: '#e3e6ea',
        'line-strong': '#d0d5db',
      },
      ink: {
        1: '#1b1f24',
        2: '#4a5158',
        3: '#7b848d',
        4: '#aab2ba',
      },
      accent: { DEFAULT: '#2f6fed', soft: '#eaf1ff' },
      ok: '#1ea672',
      warn: '#d98324',
      danger: '#d4453b',
    },
    fontFamily: {
      sans: '-apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    },
  },
  shortcuts: [
    ['card', 'bg-surface-raised border border-surface-line rounded-lg'],
    ['panel', 'bg-surface-raised border border-surface-line rounded-lg shadow-sm'],
    ['btn-base', 'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-13px font-500 select-none transition-[background-color,color,border-color,transform] duration-120 ease active:scale-[0.98] disabled:(opacity-45 cursor-not-allowed active:scale-100)'],
    ['btn-primary', 'btn-base bg-accent text-white hover:bg-#255fd0 active:bg-#1f53ba'],
    ['btn-plain', 'btn-base bg-surface-sunken text-ink-1 border border-surface-line hover:bg-#e6e9ee'],
    ['btn-ghost', 'btn-base text-ink-2 hover:bg-surface-sunken hover:text-ink-1'],
    ['field', 'h-8 px-2.5 rounded-md border border-surface-line-strong bg-surface-raised text-13px text-ink-1 outline-none focus:(border-accent ring-2 ring-accent-soft)'],
    ['label', 'text-12px text-ink-3 font-500'],
    ['muted', 'text-12px text-ink-3'],
  ],
})
