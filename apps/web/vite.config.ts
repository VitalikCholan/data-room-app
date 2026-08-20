import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The /api dev proxy mirrors the production Vercel rewrite: the browser only
// ever talks to its own origin, so the refresh cookie stays first-party.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
