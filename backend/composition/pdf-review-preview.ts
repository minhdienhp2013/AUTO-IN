import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { canonical, DomainError } from '../core/model.js';
import type { PdfReviewSnapshot } from '../core/pdf-review-source.js';

const CLI_SCHEMA = 'ai3.native_pdf_review_cli.v1';
const PREVIEW_SCHEMA = 'ai3.native_pdf_preview.v1';
const HEX = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;
const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const CLI_TIMEOUT_MS = 120_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new DomainError('PDF_PREVIEW_UNAVAILABLE', 'PDF chưa thể tạo preview an toàn; giữ đơn để nhân viên xử lý', 503, true);
const stale = () => new DomainError('STALE_PDF_PREVIEW', 'Đơn hoặc file PDF đã đổi; cần tạo preview mới', 409);
const invalid = () => new DomainError('PDF_PREVIEW_UNVERIFIED', 'Preview PDF không vượt qua kiểm tra an toàn', 409);

interface CliPage { artifact_ref: string; sha256: string; size_bytes: number }
interface CliResult {
  schema?: unknown;
  preview_schema?: unknown;
  status?: unknown;
  reason_code?: unknown;
  source_format?: unknown;
  print_source_format?: unknown;
  shop_id?: unknown;
  order_id?: unknown;
  active_revision?: unknown;
  request_hash?: unknown;
  source_sha256?: unknown;
  source_size_bytes?: unknown;
  input_manifest_sha256?: unknown;
  artifact_ref?: unknown;
  manifest_sha256?: unknown;
  preview_artifacts?: unknown;
  document_pages?: unknown;
  printed_faces?: unknown;
  physical_sheets?: unknown;
  requires_price_confirmation?: unknown;
  ready?: unknown;
  allowed_to_print?: unknown;
  allowed_to_simulate?: unknown;
  requires_staff_review?: unknown;
  physical_print_verified?: unknown;
}

export interface PdfReviewPageDto {
  index: number;
  url: string;
  content_type: 'image/png';
  sha256: string;
  bytes: number;
}
export interface PdfReviewPreviewDto {
  schema: 'ai0.pdf_review_preview.v1';
  shop_id: string;
  order_id: string;
  revision: number;
  request_hash: string;
  source_sha256: string;
  /** Digest of the verified input source manifest, not the private render bundle. */
  manifest_sha256: string;
  source_format: 'PDF';
  status: 'REVIEW_REQUIRED' | 'NEEDS_HUMAN';
  reason_code?: string;
  pages: readonly PdfReviewPageDto[];
  document_pages?: number;
  printed_faces?: number;
  physical_sheets?: number;
  settings?: Readonly<{ copies: number; paper: 'A4' | 'A3'; duplex: boolean }>;
  ready: false;
  allowed_to_print: false;
  requires_staff_review: true;
  physical_print_verified: false;
}

interface CachedPage { artifact_ref: string; sha256: string; size_bytes: number }
export interface PreparedPdfReviewPreview {
  projection: PdfReviewPreviewDto;
  shop_id: string;
  order_id: string;
  revision: number;
  request_hash: string;
  /** Server-only; never include these refs in an HTTP DTO. */
  private_pages: readonly CachedPage[];
  private_work_dir: string | null;
  private_bundle_ref: string | null;
  expires_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonNoDuplicateKeys(text: string): unknown {
  let i = 0;
  const reject = (): never => { throw invalid(); };
  const ws = () => { while (/[\u0009\u000a\u000d\u0020]/.test(text[i] ?? '')) i++; };
  const string = (): string => {
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') {
        try { return JSON.parse(text.slice(start, i)) as string; } catch { return reject(); }
      }
      if ((c ?? '') < ' ') return reject();
    }
    return reject();
  };
  const value = (): void => {
    ws(); const c = text[i];
    if (c === '{') {
      i++; ws(); const keys = new Set<string>();
      if (text[i] === '}') { i++; return; }
      while (true) {
        ws(); if (text[i] !== '"') return reject();
        const key = string(); if (keys.has(key)) return reject(); keys.add(key);
        ws(); if (text[i++] !== ':') return reject(); value(); ws();
        const end = text[i++]; if (end === '}') return; if (end !== ',') return reject();
      }
    }
    if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (true) { value(); ws(); const end = text[i++]; if (end === ']') return; if (end !== ',') return reject(); }
    }
    if (c === '"') { string(); return; }
    const literal = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(text.slice(i));
    if (literal) { i += literal[0].length; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (number) { i += number[0].length; return; }
    return reject();
  };
  value(); ws(); if (i !== text.length) return reject();
  try { return JSON.parse(text); } catch { return reject(); }
}

function safeRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value === value.trim() &&
    SAFE_REF.test(value) && !value.includes('..') && !value.startsWith('/') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function safeSettings(snapshot: PdfReviewSnapshot) {
  const request = snapshot.request_data as { documents?: unknown };
  const docs = request?.documents;
  const item = Array.isArray(docs) && docs.length === 1 ? docs[0] as Record<string, unknown> : null;
  if (!item || item.artifact_name !== snapshot.source.artifact_ref ||
      !Number.isSafeInteger(item.copies) || typeof item.duplex !== 'boolean' ||
      (item.paper !== 'A4' && item.paper !== 'A3')) throw invalid();
  return { copies: item.copies as number, duplex: item.duplex, paper: item.paper } as const;
}

function runCli(snapshot: PdfReviewSnapshot, root: string, pythonExecutable: string,
  timeoutMs: number): Promise<CliResult> {
  const input = JSON.stringify({
    schema: snapshot.schema, shop_id: snapshot.shop_id, order_id: snapshot.order_id,
    active_revision: snapshot.active_revision, request_hash: snapshot.request_hash,
    request_data: snapshot.request_data, source: snapshot.source, manifest: snapshot.manifest,
    private_bytes: {
      source_base64: Buffer.from(snapshot.private_bytes.source).toString('base64'),
      manifest_base64: Buffer.from(snapshot.private_bytes.manifest).toString('base64')
    }
  });
  if (Buffer.byteLength(input) > 36 * 1024 * 1024) return Promise.reject(unavailable());
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let failed = false;
    let settled = false;
    const child = spawn(pythonExecutable,
      ['-m', 'workers.documents.native_pdf_review_cli', '--artifact-root', root],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const terminate = () => {
      if (settled || failed) return;
      failed = true;
      try { child.kill('SIGKILL'); } catch { /* close still owns settlement */ }
    };
    const timer = setTimeout(terminate, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) { terminate(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    // The worker must not expose source contents through logs. Consume stderr
    // without retaining or forwarding it to the app logger.
    child.stderr.on('data', () => undefined);
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed || code !== 0 || !stdout.length || stdout.at(-1) !== 0x0a ||
          stdout.subarray(0, stdout.length - 1).includes(0x0a)) {
        rejectPromise(unavailable()); return;
      }
      try {
        const parsed = JSON.parse(stdout.subarray(0, stdout.length - 1).toString('utf8')) as unknown;
        if (!isRecord(parsed)) throw invalid();
        resolvePromise(parsed as CliResult);
      } catch { rejectPromise(unavailable()); }
    });
    child.stdin.on('error', terminate);
    child.stdin.end(input, 'utf8');
  });
}

async function readPrivateArtifact(root: string, ref: string, maxBytes: number): Promise<Buffer> {
  if (!safeRef(ref)) throw invalid();
  const [folder, name] = ref.split('/') as [string, string];
  const base = resolve(root), directory = resolve(base, folder), target = resolve(directory, name);
  if (!directory.startsWith(base + sep) || !target.startsWith(directory + sep)) throw invalid();
  const rootStat = await lstat(base).catch(() => null);
  const dirStat = await lstat(directory).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) ||
      !dirStat?.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077)) throw invalid();
  let file;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o022) || stat.size < 1 || stat.size > maxBytes) throw invalid();
    const bytes = await file.readFile();
    if (bytes.length !== stat.size) throw invalid();
    return bytes;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalid();
  } finally { await file?.close(); }
}

async function removeWorkDirectory(root: string, workDir: string | null): Promise<void> {
  if (!workDir) return;
  const base = resolve(root), target = resolve(workDir);
  if (!target.startsWith(base + sep)) return;
  const name = target.slice(base.length + 1);
  if (name.includes(sep) || !/^pdf-review-[A-Za-z0-9_-]+$/.test(name)) return;
  const rootStat = await lstat(base).catch(() => null);
  const stat = await lstat(target).catch(() => null);
  if (rootStat?.isDirectory() && !rootStat.isSymbolicLink() && !(rootStat.mode & 0o077) &&
      stat?.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077))
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
}

async function assertPrivateRoot(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw unavailable();
}

export function createPdfReviewPreviewService(options: {
  artifactRoot: string;
  pythonExecutable?: string;
  timeoutMs?: number;
}) {
  if (!options.artifactRoot) throw new Error('PDF_REVIEW_ARTIFACT_ROOT_REQUIRED');
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLI_TIMEOUT_MS)
    throw new Error('PDF_REVIEW_TIMEOUT_INVALID');
  const artifactRoot = resolve(options.artifactRoot);
  const python = options.pythonExecutable?.trim() || process.env.AUTOIN_PYTHON?.trim() || 'python3';
  const cache = new Map<string, PreparedPdfReviewPreview>();
  const key = (shopId: string, orderId: string, revision: number) => `${shopId}\0${orderId}\0${revision}`;

  const evict = async (entry: PreparedPdfReviewPreview | undefined) => {
    if (!entry) return;
    await removeWorkDirectory(artifactRoot, entry.private_work_dir);
  };
  const prune = async () => {
    const now = Date.now();
    for (const [entryKey, entry] of cache) {
      if (entry.expires_at <= now) { cache.delete(entryKey); await evict(entry); }
    }
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey); await evict(oldest);
    }
  };

  return {
    async prepare(snapshot: PdfReviewSnapshot): Promise<PreparedPdfReviewPreview> {
      await assertPrivateRoot(artifactRoot);
      let workDir: string | null = null;
      let keep = false;
      try {
      const settings = safeSettings(snapshot);
      workDir = await mkdtemp(join(artifactRoot, 'pdf-review-'));
      await chmod(workDir, 0o700);
      const result = await runCli(snapshot, workDir, python, timeoutMs);
      if (result.schema !== CLI_SCHEMA || result.preview_schema !== PREVIEW_SCHEMA ||
          result.shop_id !== snapshot.shop_id || result.order_id !== snapshot.order_id ||
          result.active_revision !== snapshot.active_revision || result.request_hash !== snapshot.request_hash ||
          result.source_format !== 'PDF' || result.print_source_format !== 'PDF' ||
          result.source_sha256 !== snapshot.source.sha256 || result.source_size_bytes !== snapshot.source.size_bytes ||
          result.input_manifest_sha256 !== snapshot.manifest.sha256 || result.ready !== false ||
          result.allowed_to_print !== false || result.allowed_to_simulate !== false ||
          result.requires_staff_review !== true || result.physical_print_verified !== false ||
          (result.status !== 'REVIEW_REQUIRED' && result.status !== 'NEEDS_HUMAN') ||
          typeof result.reason_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(result.reason_code)) throw invalid();

      const projection: PdfReviewPreviewDto = {
        schema: 'ai0.pdf_review_preview.v1', shop_id: snapshot.shop_id, order_id: snapshot.order_id,
        revision: snapshot.active_revision, request_hash: snapshot.request_hash,
        source_sha256: snapshot.source.sha256, manifest_sha256: snapshot.manifest.sha256,
        source_format: 'PDF', status: result.status, reason_code: result.reason_code,
        pages: [], ready: false, allowed_to_print: false, requires_staff_review: true,
        physical_print_verified: false, settings
      };

      if (result.status === 'NEEDS_HUMAN') {
        if (result.preview_artifacts !== undefined &&
            (!Array.isArray(result.preview_artifacts) || result.preview_artifacts.length !== 0)) throw invalid();
        return { projection, shop_id: snapshot.shop_id, order_id: snapshot.order_id,
          revision: snapshot.active_revision, request_hash: snapshot.request_hash,
          private_pages: [], private_work_dir: null, private_bundle_ref: null,
          expires_at: Date.now() + CACHE_TTL_MS };
      }

      if (!safeRef(result.artifact_ref) || !result.artifact_ref.endsWith('/manifest.json') ||
          !HEX.test(String(result.manifest_sha256)) || !Array.isArray(result.preview_artifacts) ||
          result.preview_artifacts.length < 1 || result.preview_artifacts.length > 15 ||
          !Number.isSafeInteger(result.document_pages) || Number(result.document_pages) < 1 || Number(result.document_pages) > 500 ||
          !Number.isSafeInteger(result.printed_faces) || Number(result.printed_faces) < 1 || Number(result.printed_faces) > 5000 ||
          !Number.isSafeInteger(result.physical_sheets) || Number(result.physical_sheets) < 1 || Number(result.physical_sheets) > 5000 ||
          Number(result.physical_sheets) > Number(result.printed_faces) ||
          typeof result.requires_price_confirmation !== 'boolean') throw invalid();

      const bundleRef = result.artifact_ref;
      const bundleFolder = bundleRef.split('/')[0];
      const manifestBytes = await readPrivateArtifact(workDir, bundleRef, 256 * 1024);
      if (sha(manifestBytes) !== result.manifest_sha256) throw invalid();
      const manifest = parseJsonNoDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
      if (!isRecord(manifest) || manifest.schema !== PREVIEW_SCHEMA || manifest.status !== 'REVIEW_REQUIRED' ||
          manifest.shop_id !== snapshot.shop_id || manifest.order_id !== snapshot.order_id ||
          manifest.active_revision !== snapshot.active_revision || manifest.request_hash !== snapshot.request_hash ||
          canonical(manifest.source) !== canonical(snapshot.source) ||
          canonical(manifest.input_manifest) !== canonical(snapshot.manifest) ||
          manifest.ready !== false || manifest.allowed_to_print !== false ||
          manifest.requires_staff_review !== true || manifest.physical_print_verified !== false ||
          manifest.evidence_kind !== 'pymupdf_pdf_preview_only' || manifest.settings_sha256 !== sha(canonical(settings)) ||
          !Array.isArray(manifest.files) || manifest.files.length !== 1 || !Array.isArray(manifest.previews) ||
          !isRecord(manifest.counts)) throw invalid();
      const file = manifest.files[0];
      if (!isRecord(file) || !safeRef(file.source_artifact_ref) ||
          file.source_artifact_ref.split('/')[0] !== bundleFolder ||
          !file.source_artifact_ref.endsWith(`source-000-${snapshot.source.sha256}.pdf`) ||
          file.file_sha256 !== snapshot.source.sha256 || file.size_bytes !== snapshot.source.size_bytes ||
          file.settings_sha256 !== sha(canonical(settings)) ||
          typeof file.render_method !== 'string' || !file.render_method.startsWith('pymupdf-')) throw invalid();
      const counts = manifest.counts as Record<string, unknown>;
      if (counts.document_pages !== result.document_pages || counts.printed_faces !== result.printed_faces ||
          counts.physical_sheets !== result.physical_sheets ||
          counts.requires_price_confirmation !== result.requires_price_confirmation) throw invalid();

      const pageRecords = result.preview_artifacts as CliPage[];
      if (manifest.previews.length !== pageRecords.length) throw invalid();
      const privatePages: CachedPage[] = [];
      const publicPages: PdfReviewPageDto[] = [];
      for (let index = 0; index < pageRecords.length; index++) {
        const page = pageRecords[index];
        const manifestPage = manifest.previews[index];
        if (!isRecord(page) || Object.keys(page).sort().join(',') !== 'artifact_ref,sha256,size_bytes' ||
            !safeRef(page.artifact_ref) || page.artifact_ref.split('/')[0] !== bundleFolder ||
            !page.artifact_ref.endsWith('.png') || !HEX.test(page.sha256) ||
            !Number.isSafeInteger(page.size_bytes) || page.size_bytes < 1 || page.size_bytes > MAX_PAGE_BYTES ||
            !isRecord(manifestPage) || manifestPage.ref !== page.artifact_ref ||
            manifestPage.sha256 !== page.sha256 || manifestPage.bytes !== page.size_bytes) throw invalid();
        const pageBytes = await readPrivateArtifact(workDir, page.artifact_ref, MAX_PAGE_BYTES);
        if (pageBytes.length !== page.size_bytes || sha(pageBytes) !== page.sha256 ||
            !pageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
        privatePages.push({ artifact_ref: page.artifact_ref, sha256: page.sha256, size_bytes: page.size_bytes });
        publicPages.push({ index, url: `/api/v1/orders/${encodeURIComponent(snapshot.order_id)}` +
          `/revisions/${snapshot.active_revision}/previews/${index}`, content_type: 'image/png',
          sha256: page.sha256, bytes: page.size_bytes });
      }
      Object.assign(projection, { pages: publicPages, document_pages: result.document_pages,
        printed_faces: result.printed_faces, physical_sheets: result.physical_sheets });
      const prepared = { projection, shop_id: snapshot.shop_id, order_id: snapshot.order_id,
        revision: snapshot.active_revision, request_hash: snapshot.request_hash,
        private_pages: privatePages, private_work_dir: workDir, private_bundle_ref: bundleRef,
        expires_at: Date.now() + CACHE_TTL_MS };
      keep = true;
      return prepared;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw unavailable();
      } finally {
        if (!keep) await removeWorkDirectory(artifactRoot, workDir);
      }
    },

    async remember(prepared: PreparedPdfReviewPreview): Promise<void> {
      await prune();
      const entryKey = key(prepared.shop_id, prepared.order_id, prepared.revision);
      const previous = cache.get(entryKey);
      cache.delete(entryKey);
      cache.set(entryKey, prepared);
      if (previous && previous.private_work_dir !== prepared.private_work_dir) await evict(previous);
      await prune();
    },

    async clearOrder(shopId: string, orderId: string): Promise<void> {
      for (const [entryKey, entry] of cache) {
        if (entry.shop_id === shopId && entry.order_id === orderId) {
          cache.delete(entryKey); await evict(entry);
        }
      }
    },

    async discard(prepared: PreparedPdfReviewPreview): Promise<void> {
      const entryKey = key(prepared.shop_id, prepared.order_id, prepared.revision);
      if (cache.get(entryKey) === prepared) cache.delete(entryKey);
      await evict(prepared);
    },

    async find(shopId: string, orderId: string, revision: number): Promise<PreparedPdfReviewPreview | null> {
      await prune();
      const entry = cache.get(key(shopId, orderId, revision));
      if (!entry || entry.expires_at <= Date.now()) return null;
      return entry;
    },

    async readPage(entry: PreparedPdfReviewPreview, index: number): Promise<Buffer> {
      const page = entry.private_pages[index];
      if (!page || !Number.isSafeInteger(index) || index < 0) throw new DomainError('NOT_FOUND', 'Preview không tồn tại', 404);
      if (!entry.private_work_dir) throw new DomainError('NOT_FOUND', 'Preview không tồn tại', 404);
      const bytes = await readPrivateArtifact(entry.private_work_dir, page.artifact_ref, MAX_PAGE_BYTES);
      if (bytes.length !== page.size_bytes || sha(bytes) !== page.sha256 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
      return bytes;
    }
  };
}
