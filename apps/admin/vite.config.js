import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 开发时把 /api 代理到云端服务（默认 http://127.0.0.1:3000），避免跨域。
// 生产部署：把本目录 dist 与云端放在同一域名下，由反向代理把 /api/* 转发到云端并去掉 /api 前缀；
// 或构建时设置 VITE_API_BASE 指向云端地址（此时云端需放行该来源的跨域，当前未实现）。
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    port: 3014,
    proxy: {
      '/api': {
        target: process.env.ADMIN_API_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
