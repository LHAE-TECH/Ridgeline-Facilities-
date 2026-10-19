import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { maybeOne, one } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { isStaff } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';

export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf',
};

export type FilePurpose = 'booking_photo' | 'before_photo' | 'after_photo' | 'receipt' | 'document' | 'signature'
  | 'contractor_invoice' | 'compliance' | 'bank_statement';

let s3: S3Client | null = null;
function s3Client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: config.storage.s3.region, endpoint: config.storage.s3.endpoint,
      credentials: { accessKeyId: config.storage.s3.accessKeyId, secretAccessKey: config.storage.s3.secretAccessKey },
      forcePathStyle: Boolean(config.storage.s3.endpoint),
    });
  }
  return s3;
}

function localPath(key: string): string {
  const base = resolve(config.storage.uploadDir);
  const p = resolve(join(base, key));
  if (!p.startsWith(base)) throw new Error('Invalid storage key');
  return p;
}

export interface SaveFileInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  purpose: FilePurpose;
  customerId?: string | null;
  contractorId?: string | null;
  jobId?: string | null;
}

/** Stores a file privately and records its SHA-256 so the original can be verified later. */
export async function saveFile(db: Db, actor: Actor, input: SaveFileInput) {
  const ext = ALLOWED_MIME[input.mimeType];
  if (!ext) throw new AppError(`File type ${input.mimeType} is not allowed (use JPEG, PNG, WebP, HEIC or PDF)`);
  if (input.buffer.length === 0) throw new AppError('Empty file');
  if (input.buffer.length > config.storage.maxUploadBytes) throw new AppError('File is too large');
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const now = new Date();
  const key = `${input.purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}${ext}`;
  if (config.storage.driver === 's3') {
    await s3Client().send(new PutObjectCommand({ Bucket: config.storage.s3.bucket, Key: key, Body: input.buffer, ContentType: input.mimeType }));
  } else {
    const p = localPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, input.buffer, { flag: 'wx' });
  }
  return one(db,
    `INSERT INTO files (storage_key, original_name, mime_type, size_bytes, sha256, customer_id, contractor_id, job_id, purpose, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [key, input.originalName.slice(0, 200) || `file${extname(key)}`, input.mimeType, input.buffer.length, sha256,
     input.customerId ?? null, input.contractorId ?? null, input.jobId ?? null, input.purpose, actor.id]);
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  if (config.storage.driver === 's3') {
    const res = await s3Client().send(new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: storageKey }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  return readFile(localPath(storageKey));
}

const CUSTOMER_VISIBLE: FilePurpose[] = ['booking_photo', 'before_photo', 'after_photo', 'signature'];
const CONTRACTOR_JOB_VISIBLE: FilePurpose[] = ['booking_photo', 'before_photo', 'after_photo', 'receipt', 'signature', 'document'];

/** Enforces data isolation for private files. */
export async function getFileForActor(db: Db, actor: Actor, fileId: string) {
  const file = await maybeOne(db, 'SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file) throw new NotFoundError('File');
  if (isStaff(actor)) return file;
  if (actor.role === 'customer') {
    if (file.customer_id === actor.customerId && CUSTOMER_VISIBLE.includes(file.purpose)) {
      // Evidence on a withdrawn record stays hidden from customers.
      const withdrawn = await maybeOne(db, 'SELECT 1 FROM job_evidence WHERE file_id = $1 AND withdrawn_at IS NOT NULL', [fileId]);
      if (!withdrawn) return file;
    }
    throw new ForbiddenError();
  }
  if (actor.role === 'contractor') {
    if (file.contractor_id && file.contractor_id === actor.contractorId) return file;
    if (file.job_id && CONTRACTOR_JOB_VISIBLE.includes(file.purpose)) {
      const job = await maybeOne(db, 'SELECT assigned_contractor_id FROM jobs WHERE id = $1', [file.job_id]);
      if (job?.assigned_contractor_id && job.assigned_contractor_id === actor.contractorId) return file;
    }
    throw new ForbiddenError();
  }
  throw new ForbiddenError();
}
