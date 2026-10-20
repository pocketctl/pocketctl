import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
export default defineConfig({plugins:[vue()],test:{environment:'happy-dom',include:['tests/share-links.docker.test.ts'],testTimeout:20000}})
