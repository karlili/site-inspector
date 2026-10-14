import { SCREENSHOT_DIR } from '../paths'
import { LocalStore } from './local'
import { S3Store } from './s3'

/**
 * Where screenshots live. Keys are `/`-separated paths such as
 * `<crawl id>/<page id>-<capture id>-desktop.jpg`; the database stores them
 * as each screenshot's `filePath` and `thumbPath`.
 */
export interface ScreenshotStore {
  /** Write an object; readers never see it half-written. */
  put(key: string, body: Buffer, contentType: string): Promise<void>
  /** The object's bytes, or null if it doesn't exist. */
  get(key: string): Promise<Buffer | null>
  /** Every key starting with `prefix`. */
  list(prefix: string): Promise<string[]>
  delete(keys: string[]): Promise<void>
  /** Delete every key starting with `prefix`. */
  deletePrefix(prefix: string): Promise<void>
}

export type StorageDriver = 'local' | 's3'

/**
 * The store picked by the environment: local disk under SCREENSHOT_DIR unless
 * SCREENSHOT_STORAGE=s3, which stores them in an S3-compatible bucket (AWS S3,
 * Cloudflare R2, Google Cloud Storage's XML API, MinIO, …). See the README.
 */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ScreenshotStore {
  const driver = (env.SCREENSHOT_STORAGE || 'local').toLowerCase()
  if (driver === 'local') return new LocalStore(SCREENSHOT_DIR)
  if (driver === 's3') {
    const bucket = env.S3_BUCKET
    if (!bucket) throw new Error('SCREENSHOT_STORAGE=s3 needs S3_BUCKET')
    return new S3Store({
      bucket,
      prefix: env.S3_PREFIX,
      region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: ['1', 'true'].includes((env.S3_FORCE_PATH_STYLE ?? '').toLowerCase()),
      // Unset: the AWS SDK's usual credential chain (AWS_ACCESS_KEY_ID, profiles, instance roles…).
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    })
  }
  throw new Error(`Unknown SCREENSHOT_STORAGE "${driver}" (expected "local" or "s3")`)
}

const globalForStore = globalThis as unknown as { __screenshotStore?: ScreenshotStore }
/** The store this process uses, created on first use. */
export function screenshotStore(): ScreenshotStore {
  return (globalForStore.__screenshotStore ??= storeFromEnv())
}

export { LocalStore, S3Store }
