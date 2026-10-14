import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ScreenshotStore } from './index'

/** Screenshots as files under a directory, keys being their relative paths. */
export class LocalStore implements ScreenshotStore {
  readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /** The file a key is stored at; refuses keys that would escape the root. */
  pathOf(key: string): string {
    const file = path.resolve(this.root, key)
    if (!file.startsWith(this.root + path.sep)) throw new Error(`Invalid storage key: ${key}`)
    return file
  }

  async put(key: string, body: Buffer, _contentType?: string) {
    const file = this.pathOf(key)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Written under a temp name first so a request never sees a half-written image.
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, body)
    await fs.rename(tmp, file)
  }

  async get(key: string) {
    try {
      return await fs.readFile(this.pathOf(key))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async list(prefix: string) {
    // Keys are `<dir>/<file>`; only the last segment can be a partial name.
    const slash = prefix.lastIndexOf('/')
    const dir = prefix.slice(0, slash + 1)
    const namePrefix = prefix.slice(slash + 1)
    const base = dir ? this.pathOf(dir) : this.root
    const entries = await fs.readdir(base, { recursive: true, withFileTypes: true }).catch(() => [])
    return entries
      .filter((e) => e.isFile())
      .map((e) => dir + path.relative(base, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
      .filter((key) => key.startsWith(dir + namePrefix) && !key.endsWith('.tmp'))
  }

  async delete(keys: string[]) {
    await Promise.all(keys.map((key) => fs.rm(this.pathOf(key), { force: true })))
  }

  async deletePrefix(prefix: string) {
    if (prefix.endsWith('/')) {
      // A whole directory, e.g. a deleted crawl's screenshots.
      await fs.rm(this.pathOf(prefix), { recursive: true, force: true })
    } else {
      await this.delete(await this.list(prefix))
    }
  }
}
