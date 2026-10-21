// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const root = resolve('ui/public/companion')
const read = (name: string) => readFileSync(resolve(root, name), 'utf8')
let pending: { src: string; resolve: () => void; reject: () => void }[]
let renderer: any
beforeEach(async () => {
  vi.useFakeTimers()
  document.body.innerHTML = read('index.html').match(/<body>([\s\S]*)<\/body>/)![1]
  pending = []
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }))
  vi.stubGlobal('DOMMatrixReadOnly', class { a = 1 })
  for (const image of document.querySelectorAll('img')) image.decode = async () => {}
  vi.stubGlobal('Image', class {
    src = ''; naturalWidth = 2; naturalHeight = 1
    decode() { return new Promise<void>((resolve, reject) => pending.push({ src: this.src, resolve, reject: () => reject(new Error('missing')) })) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {}, getImageData: () => ({ width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]) }),
  } as any)
  renderer = new Function(read('ludens/catalog.js') + '\n' + read('pet-state.js') + '\n' + read('pet.js') +
    '\nreturn {showPose,hit,speak,poses,stop:()=>clearInterval(poseTimer)};')()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  // Finish the initial pose requested by prepare().
  for (const image of pending) image.resolve()
  await Promise.resolve()
  pending = []
})
afterEach(() => { renderer?.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('commits only the latest decoded pose and keeps its alpha hit mask mirrored', async () => {
  const first = renderer.showPose({ state: '07-think', effect: null })
  const second = renderer.showPose({ state: '08-operate', effect: 'fx-question' })
  pending[1].resolve(); await second
  pending[0].resolve(); await first
  expect(document.querySelector('#pet')?.getAttribute('data-state')).toBe('08-operate')
  expect(document.querySelector('#portrait')?.getAttribute('src')).toContain('08-operate.webp')
  vi.spyOn(document.querySelector('#portrait')!, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect)
  expect(renderer.hit({ x: 25, y: 50 })).toBe(true)
  expect(renderer.hit({ x: 75, y: 50 })).toBe(false)
  vi.stubGlobal('DOMMatrixReadOnly', class { a = -1 })
  expect(renderer.hit({ x: 25, y: 50 })).toBe(false)
  expect(renderer.hit({ x: 75, y: 50 })).toBe(true)
})
it('retains usable artwork after decode failure and retries on the next refresh', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const before = document.querySelector('#portrait')?.getAttribute('src')
  const failed = renderer.showPose({ state: '24-battle', effect: null })
  pending[0].reject(); await failed
  expect(document.querySelector('#portrait')?.getAttribute('src')).toBe(before)
  const retry = renderer.showPose({ state: '24-battle', effect: null })
  pending[1].resolve(); await retry
  expect(document.querySelector('#pet')?.getAttribute('data-state')).toBe('24-battle')
})
it('keeps keyboard dialogue and reaction poses working without a native bridge', async () => {
  document.querySelector('#pet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(document.querySelector('#message')?.textContent).toBe('我在。')
  expect(document.querySelector('#bubble')?.classList.contains('open')).toBe(true)
  expect(pending.at(-1)?.src).toContain('13-poked')
})
