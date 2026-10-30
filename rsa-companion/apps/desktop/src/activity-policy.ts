import type { LogBlock } from './rsa-source.js'
export const BLOCK_KINDS = ['thinking', 'text', 'tool', 'system', 'diagnostic'] as const
export type BlockKind = typeof BLOCK_KINDS[number]
export const DEFAULT_BLOCK_VISIBILITY: Record<BlockKind, boolean> = {
  thinking: true, text: true, tool: true, system: true, diagnostic: false,
}
export interface ActivityPreferences {
  version: 2
  defaultsVersion: number
  enabled: boolean
  blocks: Record<BlockKind, boolean>
  main: boolean
  pet: boolean
  brief: boolean
  pausedUntil: number
}
export const DEFAULT_ACTIVITY_PREFERENCES: ActivityPreferences = {
  version: 2, defaultsVersion: 1, enabled: true,
  blocks: { ...DEFAULT_BLOCK_VISIBILITY },
  main: true, pet: true, brief: false, pausedUntil: 0,
}
export type NotificationStatus = 'running' | 'info' | 'success' | 'warning' | 'error' | 'neutral'
export interface SerializedNotification {
  id?: string
  status: NotificationStatus
  title: string
  description?: string
  duration: number | null
  count?: number
  revision?: number
  block?: LogBlock
}
export function briefNotification(input: SerializedNotification): SerializedNotification {
  const title = input.status === 'error' ? 'Work failed' : input.status === 'warning' ? 'Action needed'
    : input.status === 'running' ? 'Work in progress' : input.status === 'success' ? 'Work completed' : 'Activity updated'
  // No names, raw details or log blocks reach the pet in brief mode.
  return { id: input.id, status: input.status, title, duration: input.duration,
    count: input.count, revision: input.revision }
}
