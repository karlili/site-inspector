import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BucketAlreadyOwnedByYou, CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalStore, S3Store, storeFromEnv, type ScreenshotStore } from './index'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-inspector-storage-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/**
 * The S3 store runs against a real S3-compatible service when one is
 * configured, e.g. SeaweedFS from docker-compose.yml:
 * TEST_S3_ENDPOINT=http://localhost:8333 TEST_S3_BUCKET=site-inspector-test
 * TEST_S3_ACCESS_KEY_ID=seaweedfsadmin TEST_S3_SECRET_ACCESS_KEY=seaweedfsadmin
 */
const s3 = process.env.TEST_S3_BUCKET
  ? {
      bucket: process.env.TEST_S3_BUCKET,
      region: process.env.TEST_S3_REGION || 'us-east-1',
      endpoint: process.env.TEST_S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.TEST_S3_ENDPOINT,
      credentials: process.env.TEST_S3_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? '',
          }
        : undefined,
    }
  : null

const stores: [string, () => Promise<ScreenshotStore>][] = [
  ['local', async () => new LocalStore(path.join(tmp, 'screenshots'))],
]
if (s3) {
  stores.push([
    's3',
    async () => {
      // A bucket of its own on a throwaway server; an existing one otherwise.
      await new S3Client(s3)
        .send(new CreateBucketCommand({ Bucket: s3.bucket }))
        .catch((err) => {
          if (!(err instanceof BucketAlreadyOwnedByYou) && err.name !== 'BucketAlreadyExists') throw err
        })
      // Each run under its own folder, so it never touches other objects in the bucket.
      return new S3Store({ ...s3, prefix: `test-${randomUUID()}` })
    },
  ])
}

describe.each(stores)('%s screenshot store', (_, create) => {
  it('stores, lists and deletes captures', async () => {
    const store = await create()
    const jpeg = Buffer.from('jpeg bytes')
    await store.put('crawl-1/page-a-c1-desktop.jpg', jpeg, 'image/jpeg')
    await store.put('crawl-1/page-a-c1-desktop.thumb.webp', Buffer.from('thumb'), 'image/webp')
    await store.put('crawl-1/page-a-c2-desktop.jpg', Buffer.from('newer'), 'image/jpeg')
    await store.put('crawl-1/page-b-c1-desktop.jpg', Buffer.from('other page'), 'image/jpeg')
    await store.put('crawl-2/page-a-c1-desktop.jpg', Buffer.from('other crawl'), 'image/jpeg')

    expect(await store.get('crawl-1/page-a-c1-desktop.jpg')).toEqual(jpeg)
    expect(await store.get('crawl-1/missing.jpg')).toBeNull()

    // What the runner lists to drop a page's superseded captures.
    expect((await store.list('crawl-1/page-a-')).sort()).toEqual([
      'crawl-1/page-a-c1-desktop.jpg',
      'crawl-1/page-a-c1-desktop.thumb.webp',
      'crawl-1/page-a-c2-desktop.jpg',
    ])
    await store.delete(['crawl-1/page-a-c1-desktop.jpg', 'crawl-1/page-a-c1-desktop.thumb.webp'])
    expect(await store.list('crawl-1/page-a-')).toEqual(['crawl-1/page-a-c2-desktop.jpg'])

    // Deleting a crawl removes its folder and nothing else.
    await store.deletePrefix('crawl-1/')
    expect(await store.list('crawl-1/')).toEqual([])
    expect(await store.get('crawl-2/page-a-c1-desktop.jpg')).toEqual(Buffer.from('other crawl'))
    await store.deletePrefix('crawl-2/')
    expect(await store.list('crawl-2/')).toEqual([])
  })

  it('replaces an object written again under the same key', async () => {
    const store = await create()
    await store.put('crawl-3/x.webp', Buffer.from('one'), 'image/webp')
    await store.put('crawl-3/x.webp', Buffer.from('two'), 'image/webp')
    expect(await store.get('crawl-3/x.webp')).toEqual(Buffer.from('two'))
    await store.deletePrefix('crawl-3/')
  })
})

describe('local screenshot store', () => {
  it('refuses keys outside its directory', async () => {
    const store = new LocalStore(path.join(tmp, 'jail'))
    await expect(store.put('../escaped.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/Invalid storage key/)
    await expect(store.get('/etc/passwd')).rejects.toThrow(/Invalid storage key/)
    expect(fs.existsSync(path.join(tmp, 'escaped.jpg'))).toBe(false)
  })

  it('never leaves temporary files behind', async () => {
    const store = new LocalStore(path.join(tmp, 'atomic'))
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.put('c/p.webp', Buffer.from(String(i)), 'image/webp')),
    )
    expect(fs.readdirSync(path.join(tmp, 'atomic', 'c'))).toEqual(['p.webp'])
  })
})

describe('storeFromEnv', () => {
  it('stores screenshots on local disk unless told otherwise', () => {
    expect(storeFromEnv({})).toBeInstanceOf(LocalStore)
    expect(storeFromEnv({ STORAGE_DRIVER: 'local' })).toBeInstanceOf(LocalStore)
  })

  it('configures an S3-compatible bucket', () => {
    const store = storeFromEnv({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'shots',
      S3_PREFIX: '/site-inspector',
      S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      S3_REGION: 'auto',
    })
    expect(store).toBeInstanceOf(S3Store)
    expect(store).toMatchObject({ bucket: 'shots', prefix: 'site-inspector/' })
  })

  it('rejects incomplete or unknown settings', () => {
    expect(() => storeFromEnv({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/)
    expect(() => storeFromEnv({ STORAGE_DRIVER: 'ftp' })).toThrow(/Unknown STORAGE_DRIVER/)
  })
})
