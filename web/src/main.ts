import { createApp } from 'vue'
import App from './App.vue'
import { createPocketctlRouter } from './router'
import { initializePwaServiceWorker } from './pwa/registerServiceWorker'

createApp(App).use(createPocketctlRouter()).mount('#app')
void initializePwaServiceWorker()
