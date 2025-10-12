import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 👉 GitHub Pages のパス（ユーザー名/リポジトリ名）
  base: '/mokutail-tracker/',
})
