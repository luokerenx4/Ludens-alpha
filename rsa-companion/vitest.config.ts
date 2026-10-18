import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./ui/src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: { include: ['apps/desktop/src/**/*.spec.ts', 'ui/src/**/*.spec.ts', 'ui/src/**/*.spec.tsx'] },
})
