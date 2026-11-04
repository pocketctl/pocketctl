import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({base:'/',plugins:[vue()],server:{host:'127.0.0.1',port:19431,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:19432',changeOrigin:true},'/__fixture':{target:'http://127.0.0.1:19432',changeOrigin:true}}}})
