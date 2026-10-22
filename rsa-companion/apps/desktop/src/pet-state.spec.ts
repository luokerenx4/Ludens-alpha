import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const root = resolve('ui/public/companion')
const source = readFileSync(resolve(root, 'pet-state.js'), 'utf8')
const create = new Function(`${source}\nreturn createPetState;`)()

describe('Ludens static poses', () => {
  it('idles, sleeps, wakes on interaction and resumes the selected pose', () => {
    let now = 0, visible: any
    const pet = create((value: any) => { visible = value }, () => now)
    pet.refresh(); expect(visible.state).toBe('01-idle')
    now = 30000; pet.refresh(); expect(visible.state).toBe('02-perch')
    now = 90000; pet.refresh(); expect(visible.state).toBe('04-drowsy')
    now = 120000; pet.refresh(); expect(visible).toEqual({ state: '05-sleep', effect: 'fx-sleep' })
    pet.choose('21-gaming', 'fx-stars')
    pet.interact('15-dragged', Infinity)
    now += 300000; pet.refresh(); expect(visible.state).toBe('15-dragged')
    pet.interact('16-land', 900)
    now += 901; pet.refresh(); expect(visible).toEqual({ state: '21-gaming', effect: 'fx-stars' })
    pet.choose(null); expect(visible.state).toBe('01-idle')
  })
  it('uses visible log facts, prioritizes interaction and clears activity back to the selected pose', () => {
    let now = 0, visible: any
    const pet = create((value: any) => { visible = value }, () => now)
    pet.choose('22-hug-plush')
    pet.activity({ block: { kind: 'thinking', status: 'running' } })
    expect(visible.state).toBe('07-think')
    pet.interact('14-petted')
    pet.activity({ block: { kind: 'tool', status: 'running' } })
    expect(visible.state).toBe('14-petted')
    now = 2000; pet.refresh(); expect(visible.state).toBe('08-operate')
    pet.activity({ block: { kind: 'tool', status: 'complete' } }); expect(visible.state).toBe('10-success')
    pet.activity({ block: { kind: 'tool', status: 'error' } }); expect(visible.state).toBe('11-failure')
    pet.activity({ title: 'Activity updated', status: 'info' }); expect(visible.state).toBe('06-observe')
    pet.activity(null); expect(visible.state).toBe('22-hug-plush')
  })
  it('ships every catalog entry and keeps the file-free renderer catalog identical', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'ludens/manifest.json'), 'utf8'))
    const catalog = new Function(readFileSync(resolve(root, 'ludens/catalog.js'), 'utf8') + ';return ludensCatalog;')()
    expect(catalog).toEqual(manifest)
    expect(new Set(manifest.assets.map((a: any) => a.id)).size).toBe(36)
    expect(manifest.assets.filter((a: any) => a.kind === 'state')).toHaveLength(24)
    for (const asset of manifest.assets) {
      expect(existsSync(resolve(root, 'ludens', asset.file)), asset.file).toBe(true)
      if (asset.vector_file) expect(existsSync(resolve(root, 'ludens', asset.vector_file))).toBe(true)
    }
  })
})
