import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: 'src/index.js', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { output: { assetFileNames: 'index.[ext]' } },
  },
})
