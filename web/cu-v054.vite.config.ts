import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'
export default mergeConfig(base, defineConfig({server:{host:'127.0.0.1',port:3015,strictPort:true,proxy:{'/api':{target:'https://www.pocketctl.me',changeOrigin:true},'/ws':{target:'wss://www.pocketctl.me',changeOrigin:true,ws:true}}}}))
