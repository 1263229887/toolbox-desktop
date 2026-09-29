import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/tokens.css'
import './styles/reset.css'
import 'virtual:uno.css'
import './styles/base.css'

const ua = navigator.userAgent
document.documentElement.dataset.platform = /Mac|iPhone|iPad/.test(ua) ? 'darwin' : /Windows/.test(ua) ? 'win32' : 'linux'

createApp(App).use(router).mount('#app')
