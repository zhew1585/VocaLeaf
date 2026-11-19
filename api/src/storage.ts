import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Object storage as the API needs it. Reached through S3-compatible config only (ADR 0003). */
export interface ObjectStorage {
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or undefined when there is no such key. */
  getObject(key: string): Promise<Uint8Array | undefined>;
  /** Deletes the given keys; a key with no object is fine. */
  deleteObjects(keys: string[]): Promise<void>;
  /** Deletes every object whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
}

/** S3 DeleteObjects takes at most this many keys per request, and a listing page holds at most as many. */
const DELETE_BATCH = 1000;

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
    async deleteObjects(keys) {
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        const res = await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        // Quiet mode lists only the keys that could not be deleted.
        const [first] = res.Errors ?? [];
        if (first) {
          throw new Error(`could not delete ${res.Errors!.length} objects, first ${first.Key}: ${first.Code} ${first.Message}`);
        }
      }
    },
    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: DELETE_BATCH }),
        );
        await this.deleteObjects((page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
        token = page.NextContinuationToken;
      } while (token);
    },
  };
}

/** Everything stored for a Book, its original and its audio, lives under this prefix. */
export function bookPrefix(bookId: string): string {
  return `books/${bookId}/`;
}

/** Where a Book's original upload lives in the bucket. */
export function sourceKey(bookId: string): string {
  return `${bookPrefix(bookId)}source.epub`;
}

/** Where the worker puts a Book's cover image, when its EPUB has one. */
export function coverKey(bookId: string): string {
  return `${bookPrefix(bookId)}cover`;
}

/**
 * Where a render claim writes a Chapter's HLS segments. Each claim gets its own prefix, so a claim that lost
 * its lease can never overwrite the segments of the claim that took over.
 */
export function audioPrefix(bookId: string, chapterId: string, jobId: string, attempt: number): string {
  return `${bookPrefix(bookId)}audio/${chapterId}/${jobId}-${attempt}/`;
}

/** Where a Card keeps its copy of its Sentence's audio (ADTS AAC); outside the Book's prefix, so it outlives the Book. */
export function cardAudioKey(cardId: string): string {
  return `cards/${cardId}.aac`;
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
