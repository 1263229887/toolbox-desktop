import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 插件独立构建：Vue 运行时打进包里，宿主只 import 默认导出的组件。
// 产物名固定 dist/index.js + dist/index.css，与 manifest 里的 entry/style 对齐。
export default defineConfig({
  plugins: [vue()],
  // 插件以 ES 模块在渲染进程加载，浏览器里没有 process；必须把 Vue 的开发分支裁掉
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: 'src/index.js', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { output: { assetFileNames: 'index.[ext]' } },
  },
})
