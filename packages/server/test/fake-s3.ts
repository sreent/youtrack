/**
 * A small S3-compatible server for tests, in memory: path-style requests (http://host/bucket/key),
 * single and multipart uploads, ranged reads, listings, deletes, and S3's errors in S3's XML, so
 * the real SDK talks to it as it would to MinIO. It doesn't check signatures; it refuses an access
 * key other than its own, and can be told to fail what a test names.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StoredObject {
  body: Buffer;
  etag: string;
  lastModified: Date;
}

interface PendingUpload {
  bucket: string;
  key: string;
  initiated: Date;
  parts: Map<number, { body: Buffer; etag: string }>;
}

export interface SeenRequest {
  method: string;
  bucket: string;
  key: string;
  /** What the request did, as S3 names it: PutObject, UploadPart, GetObject… */
  op: string;
  range?: string;
}

type Failure = { status: number; code: string; message?: string } | 'drop';

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: Map<string, Map<string, StoredObject>>;
  uploads: Map<string, PendingUpload>;
  requests: SeenRequest[];
  /** The bucket's objects. */
  objects(bucket?: string): Map<string, StoredObject>;
  /** The next `times` requests whose operation is `op` (or every one, with "*") fail so. */
  failNext(op: string, failure: Failure, times?: number): void;
  /** Stop failing. */
  heal(): void;
  close(): Promise<void>;
}

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Bodies the SDK sends as aws-chunked (with checksums in a trailer): their chunks, joined. */
function decodeAwsChunked(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  for (;;) {
    const end = buf.indexOf('\r\n', i);
    if (end < 0) break;
    const size = Number.parseInt(buf.toString('latin1', i, end).split(';')[0]!, 16);
    i = end + 2;
    if (!size) break;
    out.push(buf.subarray(i, i + size));
    i += size + 2;
  }
  return Buffer.concat(out);
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function opOf(method: string, key: string, q: URLSearchParams, headers: IncomingMessage['headers']): string {
  if (!key) {
    if (method === 'HEAD') return 'HeadBucket';
    if (method === 'GET' && q.has('uploads')) return 'ListMultipartUploads';
    if (method === 'GET') return 'ListObjectsV2';
    return `${method}Bucket`;
  }
  if (method === 'POST' && q.has('uploads')) return 'CreateMultipartUpload';
  if (method === 'PUT' && q.has('uploadId')) return 'UploadPart';
  if (method === 'POST' && q.has('uploadId')) return 'CompleteMultipartUpload';
  if (method === 'DELETE' && q.has('uploadId')) return 'AbortMultipartUpload';
  if (method === 'PUT' && headers['x-amz-copy-source']) return 'CopyObject';
  if (method === 'PUT') return 'PutObject';
  if (method === 'GET') return 'GetObject';
  if (method === 'HEAD') return 'HeadObject';
  if (method === 'DELETE') return 'DeleteObject';
  return method;
}

export async function startFakeS3(opts: { bucket?: string; accessKeyId?: string; secretAccessKey?: string } = {}): Promise<FakeS3> {
  const bucket = opts.bucket ?? 'files';
  const accessKeyId = opts.accessKeyId ?? 'test-key';
  const buckets = new Map<string, Map<string, StoredObject>>([[bucket, new Map()]]);
  const uploads = new Map<string, PendingUpload>();
  const requests: SeenRequest[] = [];
  const failures: { op: string; failure: Failure; left: number }[] = [];

  const send = (res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...(body ? { 'content-type': 'application/xml' } : {}), 'content-length': String(Buffer.byteLength(body)), 'x-amz-request-id': 'fake', ...headers });
    res.end(body);
  };
  const error = (res: ServerResponse, status: number, code: string, message = code, head = false) =>
    send(res, status, head ? '' : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message><RequestId>fake</RequestId></Error>`);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const [, b = '', ...rest] = url.pathname.split('/');
    const name = decodeURIComponent(b);
    const key = rest.map(decodeURIComponent).join('/');
    const q = url.searchParams;
    const method = req.method ?? 'GET';
    const op = opOf(method, key, q, req.headers);
    const head = method === 'HEAD';
    requests.push({ method, bucket: name, key, op, ...(req.headers.range ? { range: String(req.headers.range) } : {}) });
    const raw = await read(req);

    const failing = failures.find((f) => f.left > 0 && (f.op === op || f.op === '*'));
    if (failing) {
      failing.left--;
      if (failing.failure === 'drop') {
        req.socket.destroy();
        return;
      }
      error(res, failing.failure.status, failing.failure.code, failing.failure.message, head);
      return;
    }
    const credential = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ''))?.[1];
    if (credential !== accessKeyId) {
      error(res, 403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.', head);
      return;
    }
    const objects = buckets.get(name);
    if (!objects) {
      error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist', head);
      return;
    }
    const body = String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-') ? decodeAwsChunked(raw) : raw;

    switch (op) {
      case 'HeadBucket':
        send(res, 200);
        return;
      case 'ListObjectsV2': {
        const prefix = q.get('prefix') ?? '';
        const max = Number(q.get('max-keys') ?? 1000);
        const after = q.get('continuation-token') ?? q.get('start-after') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, max);
        const truncated = keys.length > page.length;
        const contents = page
          .map((k) => {
            const o = objects.get(k)!;
            return `<Contents><Key>${xml(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          })
          .join('');
        send(
          res,
          200,
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(name)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${xml(page.at(-1)!)}</NextContinuationToken>` : ''}</ListBucketResult>`,
        );
        return;
      }
      case 'ListMultipartUploads': {
        const prefix = q.get('prefix') ?? '';
        const list = [...uploads.entries()].filter(([, u]) => u.bucket === name && u.key.startsWith(prefix));
        const items = list.map(([id, u]) => `<Upload><Key>${xml(u.key)}</Key><UploadId>${id}</UploadId><Initiated>${u.initiated.toISOString()}</Initiated></Upload>`).join('');
        send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult><Bucket>${xml(name)}</Bucket><IsTruncated>false</IsTruncated>${items}</ListMultipartUploadsResult>`);
        return;
      }
      case 'CreateMultipartUpload': {
        const id = randomUUID();
        uploads.set(id, { bucket: name, key, initiated: new Date(), parts: new Map() });
        send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xml(name)}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        return;
      }
      case 'UploadPart': {
        const u = uploads.get(q.get('uploadId') ?? '');
        if (!u) return error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
        const etag = md5(body);
        u.parts.set(Number(q.get('partNumber')), { body, etag });
        send(res, 200, '', { etag: `"${etag}"` });
        return;
      }
      case 'CompleteMultipartUpload': {
        const id = q.get('uploadId') ?? '';
        const u = uploads.get(id);
        if (!u) return error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
        // Each <Part> names its number and ETag, in whichever order the client writes them.
        const listed = [...body.toString('utf8').matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
          n: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1]!)?.[1]),
          etag: (/<ETag>([^<]+)<\/ETag>/.exec(m[1]!)?.[1] ?? '').replace(/&quot;|"/g, ''),
        }));
        if (!listed.length) return error(res, 400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema');
        const chunks: Buffer[] = [];
        for (const [i, p] of listed.entries()) {
          const part = u.parts.get(p.n);
          if (!part || part.etag !== p.etag) return error(res, 400, 'InvalidPart', `Part ${p.n} is not one that was uploaded.`);
          if (i < listed.length - 1 && part.body.length < 5 * 1024 * 1024) return error(res, 400, 'EntityTooSmall', 'Your proposed upload is smaller than the minimum allowed size');
          chunks.push(part.body);
        }
        uploads.delete(id);
        const whole = Buffer.concat(chunks);
        const etag = `${md5(Buffer.concat(listed.map((p) => Buffer.from(p.etag, 'hex'))))}-${listed.length}`;
        objects.set(key, { body: whole, etag, lastModified: new Date() });
        send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${xml(name)}</Bucket><Key>${xml(key)}</Key><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`);
        return;
      }
      case 'AbortMultipartUpload': {
        const id = q.get('uploadId') ?? '';
        if (!uploads.delete(id)) return error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
        send(res, 204);
        return;
      }
      case 'PutObject': {
        const etag = md5(body);
        objects.set(key, { body, etag, lastModified: new Date() });
        send(res, 200, '', { etag: `"${etag}"` });
        return;
      }
      case 'GetObject':
      case 'HeadObject': {
        const o = objects.get(key);
        if (!o) return error(res, 404, head ? 'NotFound' : 'NoSuchKey', 'The specified key does not exist.', head);
        const common = { etag: `"${o.etag}"`, 'last-modified': o.lastModified.toUTCString(), 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' };
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (range && !head) {
          const start = Number(range[1]);
          if (start >= o.body.length) return error(res, 416, 'InvalidRange', 'The requested range is not satisfiable');
          const end = Math.min(range[2] ? Number(range[2]) : o.body.length - 1, o.body.length - 1);
          const part = o.body.subarray(start, end + 1);
          res.writeHead(206, { ...common, 'content-length': String(part.length), 'content-range': `bytes ${start}-${end}/${o.body.length}` });
          res.end(part);
          return;
        }
        res.writeHead(200, { ...common, 'content-length': String(o.body.length) });
        res.end(head ? undefined : o.body);
        return;
      }
      case 'DeleteObject':
        objects.delete(key);
        send(res, 204);
        return;
      default:
        error(res, 501, 'NotImplemented', `The fake doesn't do ${op}`);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) error(res, 500, 'InternalError', e instanceof Error ? e.message : String(e));
      else res.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId,
    secretAccessKey: opts.secretAccessKey ?? 'test-secret',
    buckets,
    uploads,
    requests,
    objects: (b = bucket) => buckets.get(b) ?? new Map(),
    failNext: (op, failure, times = 1) => void failures.push({ op, failure, left: times }),
    heal: () => void (failures.length = 0),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
