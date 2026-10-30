import { readFileSync, statSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { z } from 'zod'
import { DEFAULT_ACTIVITY_PREFERENCES, DEFAULT_BLOCK_VISIBILITY, type ActivityPreferences } from './activity-policy.js'
const controls = {
  enabled: z.boolean(), main: z.boolean(), pet: z.boolean(), brief: z.boolean(),
  pausedUntil: z.number().finite().nonnegative().max(8.64e15),
}
const blocksSchema = z.object({ thinking: z.boolean(), text: z.boolean(), tool: z.boolean(), system: z.boolean(), diagnostic: z.boolean() }).strict()
export const preferencesSchema = z.object({
  version: z.literal(2), defaultsVersion: z.number().int().nonnegative(),
  blocks: blocksSchema.default(DEFAULT_BLOCK_VISIBILITY), ...controls,
}).strict()
export function migrateActivityPreferences(input: unknown): ActivityPreferences {
  // A new official default never replaces an existing explicit choice.
  return preferencesSchema.parse(input)
}
export function createActivityPreferenceStore(path: string, defaults = DEFAULT_ACTIVITY_PREFERENCES) {
  let current = structuredClone(defaults)
  try { if (statSync(path).size < 16_384) current = migrateActivityPreferences(JSON.parse(readFileSync(path, 'utf8'))) } catch { /* Invalid disk state: official defaults. */ }
  let queue = Promise.resolve()
  const persist = async (value: ActivityPreferences) => {
    await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 })
    await rename(path + '.tmp', path)
    current = value
    return structuredClone(current)
  }
  const enqueue = (fn: () => Promise<ActivityPreferences>) => { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next }
  return {
    get: () => structuredClone(current),
    update(input: unknown) {
      const patch = preferencesSchema.omit({ version: true, defaultsVersion: true, blocks: true }).extend({ blocks: blocksSchema.partial() }).partial().parse(input)
      return enqueue(() => persist(preferencesSchema.parse({ ...current, ...patch,
        blocks: { ...current.blocks, ...patch.blocks },
      })))
    },
    reset: () => enqueue(() => persist({ ...current, defaultsVersion: defaults.defaultsVersion,
      blocks: { ...defaults.blocks },
    })),
  }
}
