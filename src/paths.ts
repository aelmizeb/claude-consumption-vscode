import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'

/** The Claude Code configuration directory: the setting, else CLAUDE_CONFIG_DIR, else ~/.claude. */
export function configDir(setting: string | undefined): string {
  const custom = (setting ?? '').trim() || (process.env.CLAUDE_CONFIG_DIR ?? '').trim()

  if (custom) return custom.replace(/[\\/]+$/, '')

  return path.join(os.homedir(), '.claude')
}

/** The name Claude Code gives a project's directory: its path with everything but letters and digits turned into `-`. */
export function projectSlug(folder: string): string {
  return folder.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-')
}

/** The folder and its parents, from the deepest to the root. */
export function ancestors(folder: string): string[] {
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]/)
  const out: string[] = []

  for (let n = parts.length; n >= 1; n -= 1) out.push(parts.slice(0, n).join('/'))

  return out
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)

    return true
  } catch {
    return false
  }
}

/**
 * The Claude Code project directories (`<config>/projects/<slug>`) to follow: all of them with `all`,
 * otherwise those of the open folders and of their sub-folders (names are compared case-insensitively,
 * as the Windows drive letter varies from one session to the next).
 */
export async function projectDirs(root: string, folders: readonly string[], all: boolean): Promise<string[]> {
  const projects = path.join(root, 'projects')
  let names: string[]

  try {
    names = (await fs.readdir(projects, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }

  if (all) return names.map(name => path.join(projects, name))

  const slugs = folders.map(folder => projectSlug(folder).toLowerCase())

  return names
    .filter(name => {
      const lower = name.toLowerCase()

      return slugs.some(slug => lower === slug || lower.startsWith(`${slug}-`))
    })
    .map(name => path.join(projects, name))
}

/** The auto-memory directory of an open folder: the folder's own, or the first parent that has one. */
export async function memoryIndexFor(root: string, folder: string): Promise<string | undefined> {
  for (const candidate of ancestors(folder)) {
    const slug = projectSlug(candidate)

    for (const name of [slug, slug.toLowerCase()]) {
      const index = path.join(root, 'projects', name, 'memory', 'MEMORY.md')

      if (await exists(index)) return index
    }
  }

  return undefined
}
