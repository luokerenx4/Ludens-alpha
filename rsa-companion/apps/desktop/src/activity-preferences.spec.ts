import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createActivityPreferenceStore, migrateActivityPreferences } from './activity-preferences.js'
import { DEFAULT_ACTIVITY_PREFERENCES as defaults, type ActivityPreferences } from './activity-policy.js'
describe('activity preferences', () => {
  it('shows thinking, text and tools by default and leaves diagnostic details opt-in', () => {
    expect(defaults.blocks).toEqual({ thinking: true, text: true, tool: true, system: true, diagnostic: false })
    expect(defaults.brief).toBe(false)
  })
  it('adds missing block defaults without replacing saved controls and persists partial block edits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsa-block-prefs-')), path = join(dir, 'prefs.json')
    try {
      const { blocks, ...saved } = { ...defaults, enabled: false, brief: true, pet: false, pausedUntil: 1234 }
      writeFileSync(path, JSON.stringify(saved))
      const store = createActivityPreferenceStore(path)
      expect(store.get()).toEqual({ ...saved, blocks })
      await Promise.all([store.update({ blocks: { diagnostic: true } }), store.update({ blocks: { thinking: false } })])
      expect(createActivityPreferenceStore(path).get()).toEqual({ ...saved, blocks: { ...blocks, diagnostic: true, thinking: false } })
      expect(() => store.update({ blocks: { unknown: true } })).toThrow()
      expect(() => store.update({ blocks: { text: 'show' } })).toThrow()
      await store.reset()
      expect(createActivityPreferenceStore(path).get()).toEqual({ ...saved, blocks })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('initializes, persists serial edits/restart, resets only blocks and validates writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsa-notify-')), path = join(dir, 'prefs.json')
    try {
      const store = createActivityPreferenceStore(path); expect(store.get()).toEqual(defaults)
      await Promise.all([store.update({ blocks: { diagnostic: true } }), store.update({ brief: true, enabled: false, main: false, pet: false, pausedUntil: 100, blocks: { tool: false } })])
      const saved = { ...defaults, brief: true, enabled: false, main: false, pet: false, pausedUntil: 100, blocks: { ...defaults.blocks, diagnostic: true, tool: false } }
      expect(createActivityPreferenceStore(path).get()).toEqual(saved)
      expect(() => store.update({ unknown: true })).toThrow()
      const before = readFileSync(path, 'utf8'); expect(() => store.update({ pausedUntil: Infinity })).toThrow(); expect(readFileSync(path, 'utf8')).toBe(before)
      await store.reset(); expect(createActivityPreferenceStore(path).get()).toEqual({ ...saved, blocks: defaults.blocks })
      writeFileSync(path, '{"corrupt":true}'); expect(createActivityPreferenceStore(path).get()).toEqual(defaults)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('keeps explicit choices across default versions and rejects future schemas', () => {
    const old: ActivityPreferences = { ...defaults, defaultsVersion: 0, blocks: { thinking: false, text: false, tool: false, system: false, diagnostic: true } }
    expect(migrateActivityPreferences(old)).toEqual(old)
    expect(() => migrateActivityPreferences({ ...old, version: 999 })).toThrow()
  })
})
