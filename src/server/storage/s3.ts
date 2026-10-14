import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { ScreenshotStore } from './index'

export interface S3StoreOptions {
  bucket: string
  /** Folder inside the bucket every key goes under, e.g. `site-inspector/`. */
  prefix?: string
  region: string
  /** For services other than AWS, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string
  /** `bucket.host/key` URLs don't work with MinIO and some self-hosted services. */
  forcePathStyle?: boolean
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

/** How many deletes run at once; the multi-object delete call isn't supported everywhere (e.g. GCS). */
const DELETE_CONCURRENCY = 16

/** Screenshots in an S3-compatible bucket. */
export class S3Store implements ScreenshotStore {
  readonly bucket: string
  readonly prefix: string
  private readonly client: S3Client

  constructor(options: S3StoreOptions) {
    this.bucket = options.bucket
    this.prefix = options.prefix ? options.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : ''
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: options.credentials,
      // Newer SDKs send CRC checksums by default, which R2, GCS and older MinIO reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: body,
        ContentType: contentType,
        // Keys are unique per capture, so an object never changes.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }))
      return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') return null
      throw err
    }
  }

  async list(prefix: string) {
    const keys: string[] = []
    let token: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix + prefix,
          ContinuationToken: token,
        }),
      )
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key.slice(this.prefix.length))
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return keys
  }

  async delete(keys: string[]) {
    const queue = [...keys]
    await Promise.all(
      Array.from({ length: Math.min(DELETE_CONCURRENCY, queue.length) }, async () => {
        for (let key; (key = queue.pop()) !== undefined; ) {
          await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }))
        }
      }),
    )
  }

  async deletePrefix(prefix: string) {
    await this.delete(await this.list(prefix))
  }
}
