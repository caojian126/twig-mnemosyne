import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

// 版本牌单一事实源：web/app/package.json（rail.js 经 __APP_VERSION__ 注入展示）
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))

// MPA：7 个页面 + 登录页；开发时 /v1/*、/metrics、/health 反代到本地 runtime。
// 生产由 Caddy 托管 dist/ 并做同样的反代（见根目录 Caddyfile）。
const page = name => resolvePage(`${name}.html`)

function resolvePage(file) {
  return fileURLToPath(new URL(file, import.meta.url))
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': process.env.VITE_UPSTREAM ?? 'http://127.0.0.1:8000',
      '/metrics': process.env.VITE_UPSTREAM ?? 'http://127.0.0.1:8000',
      '/health': process.env.VITE_UPSTREAM ?? 'http://127.0.0.1:8000',
    },
  },
  build: {
    // 产物落在 web/dist（docker-compose caddy 挂载 ./web/dist:/srv/www）
    outDir: '../dist',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: page('index'),
        book: page('book'),
        explorer: page('explorer'),
        observatory: page('observatory'),
        forge: page('forge'),
        console: page('console'),
        settings: page('settings'),
        login: page('login'),
      },
    },
  },
})
