import { createRouter, createWebHashHistory } from 'vue-router'
import Home from '@/views/Home.vue'

export default createRouter({
  // 打包后走 file://，history 模式没有服务端兜底，只能用 hash
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: Home, meta: { title: '全部工具' } },
    { path: '/tool/:id', name: 'tool', component: () => import('@/views/ToolHost.vue') },
    { path: '/plugins', name: 'plugins', component: () => import('@/views/PluginsView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/:any(.*)*', redirect: '/' },
  ],
})
