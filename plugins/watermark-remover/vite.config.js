import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

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
