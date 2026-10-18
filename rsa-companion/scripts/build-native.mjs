import { build } from 'esbuild'
import { existsSync } from 'node:fs'
const candidates = ['main', 'preload', 'companion-preview', 'companion-preload']
await build({
  entryPoints: candidates.map(name => `apps/desktop/src/${name}.ts`).filter(existsSync),
  outdir: 'dist/electron',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['electron'],
  sourcemap: true,
})
