import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// 本机服务端口：e2e 脚本（apps/renderer/e2e）用 TALEKILN_API_PORT 把代理指到临时端口，默认 5679
const apiTarget = `http://127.0.0.1:${process.env.TALEKILN_API_PORT || 5679}`

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0',
    port: 3013,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        proxyTimeout: 600000,
        timeout: 600000
      },
      '/static': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
})
