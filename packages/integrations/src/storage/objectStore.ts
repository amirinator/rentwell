/**
 * Private object storage for import files.
 *
 * Uploaded files can contain a property's entire payment history, so the bucket
 * is private and stays private:
 *
 *  - No object is ever written with a public ACL.
 *  - Downloads go through a short-lived signed URL, minted only after the API
 *    has checked that the caller may read that import.
 *  - Keys are namespaced by organization and import id, so a guessed key from
 *    one organization cannot name an object in another.
 *
 * MinIO is used locally; the same code talks to S3 in a deployment.
 */

import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO needs path-style addressing; S3 does not. */
  readonly forcePathStyle?: boolean;
  readonly signedUrlTtlSeconds?: number;
}

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  /** SHA-256 of the stored bytes, in lowercase hex. */
  readonly sha256: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Builds the storage key for an import file.
 *
 * The organization id is the first path segment deliberately: it makes every
 * object's owner visible in the key itself, and a bucket policy can be scoped
 * by prefix if the deployment wants defence in depth.
 */
export function importObjectKey(
  organizationId: string,
  importId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `imports/${organizationId}/${importId}/${safeName}`;
}

export class ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttlSeconds: number;

  constructor(config: ObjectStoreConfig) {
    this.bucket = config.bucket;
    this.ttlSeconds = config.signedUrlTtlSeconds ?? 300;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /** Stores bytes and returns their size and hash. Never sets a public ACL. */
  async put(key: string, body: Buffer, contentType = 'text/csv'): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Belt and braces: the bucket denies anonymous access, and no object
        // asks for it either.
        ACL: 'private',
        ServerSideEncryption: undefined,
      }),
    );

    return { key, sizeBytes: body.byteLength, sha256: sha256Hex(body) };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!body) throw new Error(`Object ${key} has no body`);

    const chunks: Buffer[] = [];
    // @ts-expect-error - the SDK types Body as a union; in Node it is a stream.
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Mints a short-lived upload URL for a specific key.
   *
   * The key is chosen by the server, never by the client, so an upload cannot
   * be aimed at another organization's prefix or at an existing object. The
   * content type is pinned to CSV, so the presigned request cannot be reused to
   * store something else at that key.
   */
  async signedUploadUrl(key: string, contentType = 'text/csv'): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ACL: 'private',
    });
    return getSignedUrl(this.client, command, { expiresIn: this.ttlSeconds });
  }

  /**
   * Mints a short-lived download URL.
   *
   * The caller must already have authorized the request: this method performs
   * no permission check of its own, and a URL it returns grants access to
   * anyone holding it until it expires.
   */
  async signedDownloadUrl(key: string, filename?: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(filename
        ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"` }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: this.ttlSeconds });
  }

  async healthCheck(): Promise<string> {
    await this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: '__healthcheck__' }))
      .catch((error: unknown) => {
        // A 404 proves the bucket is reachable and we are authenticated, which
        // is exactly what readiness needs to know.
        const name = (error as { name?: string })?.name;
        if (name === 'NotFound' || name === 'NoSuchKey') return;
        throw error;
      });
    return `bucket ${this.bucket} reachable`;
  }
}
