import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { memoryIndexFor } from './paths'
import { FleetMemory } from './types'

/** Reads the MEMORY.md index of the first open folder that has one: one entry per `- [Title](file)` line. */
export async function readMemory(root: string, folders: readonly string[], now: number): Promise<FleetMemory> {
  for (const folder of folders) {
    const index = await memoryIndexFor(root, folder)

    if (!index) continue

    try {
      const text = await fs.readFile(index, 'utf8')
      const entries = text
        .split('\n')
        .map(line => /^\s*-\s*\[([^\]]+)\]/.exec(line)?.[1]?.trim())
        .filter((title): title is string => Boolean(title))

      return { entries, path: path.dirname(index), readAt: now }
    } catch {
      // Unreadable index: try the next folder.
    }
  }

  return { entries: [], readAt: now }
}
