import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Object storage as the API needs it. Reached through S3-compatible config only (ADR 0003). */
export interface ObjectStorage {
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or undefined when there is no such key. */
  getObject(key: string): Promise<Uint8Array | undefined>;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function s3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Local S3 servers need path-style URLs; R2 accepts them too.
    forcePathStyle: true,
  });
}

/** S3-compatible storage: RustFS in development, Cloudflare R2 in production, switched by env. */
export function s3Storage(config: S3Config): ObjectStorage {
  const client = s3Client(config);
  return {
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async getObject(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        return await res.Body!.transformToByteArray();
      } catch (err) {
        if (err instanceof NoSuchKey) return undefined;
        throw err;
      }
    },
  };
}

/** Where a Book's original upload lives in the bucket. */
export function sourceKey(bookId: string): string {
  return `books/${bookId}/source.epub`;
}

/**
 * Where a render claim writes a Chapter's HLS segments. Each claim gets its own prefix, so a claim that lost
 * its lease can never overwrite the segments of the claim that took over.
 */
export function audioPrefix(bookId: string, chapterId: string, jobId: string, attempt: number): string {
  return `books/${bookId}/audio/${chapterId}/${jobId}-${attempt}/`;
}

/**
 * Creates the bucket when it does not exist yet, so a fresh `docker compose up` needs no setup step.
 * In production the bucket already exists, so only HeadBucket runs.
 */
export async function ensureBucket(config: S3Config): Promise<void> {
  const client = s3Client(config);
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw err;
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  }
}
