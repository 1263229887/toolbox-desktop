import { createApp } from 'vue'
import Index from './Index.vue'
import css from './style.css?inline'

// 样式打进 JS 并自己注入：宿主挂 <link> 在自定义协议上不稳，scoped 的 data-v 又会和独立构建对不上
if (typeof document !== 'undefined' && !document.querySelector('style[data-wm-style]')) {
  const el = document.createElement('style')
  el.setAttribute('data-wm-style', '1')
  el.textContent = css
  document.head.appendChild(el)
}

/**
 * 插件自带 Vue，必须用自己的 createApp 挂载。
 * 若由宿主 Vue 的 <component :is> 渲染，会变成两套响应式，点击后状态不刷新（看似没反应）。
 */
export function mount(el, props = {}) {
  const app = createApp(Index, props)
  app.mount(el)
  return {
    unmount() {
      app.unmount()
      el.innerHTML = ''
    },
  }
}

export default Index
