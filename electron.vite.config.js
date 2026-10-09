import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

export default defineConfig({
  main: {
    // 主进程是能力层：依赖留在 node_modules 里由 Node 解析，不打进 bundle。
    plugins: [externalizeDepsPlugin({ exclude: ['extract-zip'] })],
    build: {
      external,
      rollupOptions: { input: { index: 'src/main/index.js' } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { external, rollupOptions: { input: { index: 'src/preload/index.js' } } },
  },
  renderer: {
    resolve: { alias: { '@': `${root}src/renderer/src` } },
    plugins: [vue(), UnoCSS()],
    build: { rollupOptions: { input: { index: `${root}src/renderer/index.html` } } },
  },
})
