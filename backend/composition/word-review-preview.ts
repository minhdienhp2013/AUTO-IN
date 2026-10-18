import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { canonical, DomainError } from '../core/model.js';
import type { WordReviewSnapshot } from '../core/word-review-source.js';

const CLI_SCHEMA = 'ai3.native_word_review_cli.v1';
const PREVIEW_SCHEMA = 'ai3.native_word_preview.v1';
const HEX = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;
const REASON = /^[A-Z][A-Z0-9_]{0,79}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;
const OUTPUT_KEYS = [
  'schema', 'preview_schema', 'status', 'reason_code', 'source_format', 'print_source_format',
  'shop_id', 'order_id', 'active_revision', 'request_hash', 'source_sha256', 'source_size_bytes',
  'input_manifest_sha256', 'artifact_ref', 'manifest_sha256', 'settings_sha256', 'preview_artifacts',
  'document_pages', 'printed_faces', 'physical_sheets', 'requires_price_confirmation',
  'renderer_identity', 'native_word_verified', 'ready', 'allowed_to_print', 'allowed_to_simulate',
  'requires_staff_review', 'physical_print_verified'
].sort().join(',');

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new DomainError('WORD_PREVIEW_UNAVAILABLE',
  'Word chưa thể tạo preview an toàn; giữ đơn để nhân viên xử lý', 503, true);
const invalid = () => new DomainError('WORD_PREVIEW_UNVERIFIED',
  'Preview Word không vượt qua kiểm tra an toàn; giữ đơn để nhân viên xử lý', 409);

interface CliPage { artifact_ref: string; sha256: string; size_bytes: number }
interface CliResult {
  schema?: unknown; preview_schema?: unknown; status?: unknown; reason_code?: unknown;
  source_format?: unknown; print_source_format?: unknown; shop_id?: unknown; order_id?: unknown;
  active_revision?: unknown; request_hash?: unknown; source_sha256?: unknown; source_size_bytes?: unknown;
  input_manifest_sha256?: unknown; artifact_ref?: unknown; manifest_sha256?: unknown; settings_sha256?: unknown;
  preview_artifacts?: unknown; document_pages?: unknown; printed_faces?: unknown; physical_sheets?: unknown;
  requires_price_confirmation?: unknown; renderer_identity?: unknown; native_word_verified?: unknown;
  ready?: unknown; allowed_to_print?: unknown; allowed_to_simulate?: unknown;
  requires_staff_review?: unknown; physical_print_verified?: unknown;
}

export interface WordReviewPageDto {
  index: number;
  url: string;
  content_type: 'image/png';
  sha256: string;
  bytes: number;
}
export interface WordReviewPreviewDto {
  schema: 'ai0.word_review_preview.v1';
  shop_id: string;
  order_id: string;
  revision: number;
  request_hash: string;
  source_sha256: string;
  manifest_sha256: string;
  status: 'REVIEW_REQUIRED' | 'NEEDS_HUMAN';
  reason_code?: string;
  pages: readonly WordReviewPageDto[];
  document_pages?: number;
  printed_faces?: number;
  physical_sheets?: number;
  settings?: Readonly<Record<string, string | number | boolean>>;
  ready: false;
  allowed_to_print: false;
  requires_staff_review: true;
  physical_print_verified: false;
}

interface CachedPage { artifact_ref: string; sha256: string; size_bytes: number; index: number }
export interface PreparedWordReviewPreview {
  projection: WordReviewPreviewDto;
  shop_id: string;
  order_id: string;
  revision: number;
  request_hash: string;
  source_sha256: string;
  source_manifest_sha256: string;
  /** Private per-request directory; never include it in an HTTP response. */
  private_work_dir: string | null;
  private_bundle_ref: string | null;
  private_pages: readonly CachedPage[];
  expires_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value === value.trim() && SAFE_REF.test(value) && !value.includes('..') &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
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

function safeSettings(snapshot: WordReviewSnapshot): Record<string, string | number | boolean> {
  const request = snapshot.request_data as { documents?: unknown };
  const docs = request?.documents;
  const item = Array.isArray(docs) && docs.length === 1 ? docs[0] as Record<string, unknown> : null;
  if (!item || (item.artifact_name !== snapshot.source.artifact_ref &&
      item.artifact_name !== snapshot.source.artifact_ref.split('/').at(-1))) throw invalid();
  const settings = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'artifact_name'));
  if (Object.values(settings).some(value => typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'))
    throw invalid();
  return settings as Record<string, string | number | boolean>;
}

function runCli(snapshot: WordReviewSnapshot, root: string, pythonExecutable: string,
  allowWordLaunch: boolean): Promise<CliResult> {
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
    let stdout = Buffer.alloc(0), failed = false, settled = false;
    const args = ['-m', 'workers.documents.native_word_review_cli', '--artifact-root', root];
    if (allowWordLaunch) args.push('--allow-word-launch');
    const child = spawn(pythonExecutable, args,
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const kill = () => { if (!settled && !failed) { failed = true; child.kill('SIGKILL'); } };
    const timer = setTimeout(kill, 120_000);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) { kill(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', () => undefined);
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      settled = true; clearTimeout(timer);
      if (failed || code !== 0 || !stdout.length || stdout.at(-1) !== 0x0a ||
          stdout.subarray(0, stdout.length - 1).includes(0x0a)) { rejectPromise(unavailable()); return; }
      try {
        const parsed = parseJsonNoDuplicateKeys(stdout.subarray(0, stdout.length - 1).toString('utf8'));
        if (!isRecord(parsed)) throw invalid();
        resolvePromise(parsed as CliResult);
      } catch { rejectPromise(unavailable()); }
    });
    child.stdin.on('error', () => { failed = true; });
    child.stdin.end(input, 'utf8');
  });
}

async function assertPrivateRoot(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw unavailable();
}

async function readPrivateArtifact(root: string, ref: string, maxBytes: number): Promise<Buffer> {
  if (!safeRef(ref)) throw invalid();
  const [folder, name] = ref.split('/') as [string, string];
  if (!/^doc-[A-Za-z0-9_-]{6,64}$/.test(folder)) throw invalid();
  const base = resolve(root), directory = resolve(base, folder), target = resolve(directory, name);
  if (!directory.startsWith(base + sep) || !target.startsWith(directory + sep)) throw invalid();
  const rootStat = await lstat(base).catch(() => null), dirStat = await lstat(directory).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) ||
      !dirStat?.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077)) throw invalid();
  let file;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size < 1 || stat.size > maxBytes) throw invalid();
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
  if (!target.startsWith(base + sep) || !/^word-review-[A-Za-z0-9_-]+$/.test(target.slice(base.length + 1).split(sep)[0] ?? '')) return;
  const rootStat = await lstat(base).catch(() => null), stat = await lstat(target).catch(() => null);
  if (rootStat?.isDirectory() && !rootStat.isSymbolicLink() && !(rootStat.mode & 0o077) &&
      stat?.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077))
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
}

export function createWordReviewPreviewService(options: {
  artifactRoot: string;
  pythonExecutable?: string;
  /** Explicit operator configuration; false is the default and never launches Word. */
  allowWordLaunch?: boolean;
}) {
  if (!options.artifactRoot) throw new Error('WORD_REVIEW_ARTIFACT_ROOT_REQUIRED');
  if (options.allowWordLaunch !== undefined && typeof options.allowWordLaunch !== 'boolean')
    throw new Error('WORD_LAUNCH_CONFIGURATION_INVALID');
  const artifactRoot = resolve(options.artifactRoot);
  const python = options.pythonExecutable?.trim() || process.env.AUTOIN_PYTHON?.trim() || 'python3';
  const allowWordLaunch = options.allowWordLaunch === true;
  const cache = new Map<string, PreparedWordReviewPreview>();
  const key = (shopId: string, orderId: string, revision: number) => `${shopId}\0${orderId}\0${revision}`;

  const evict = async (entry: PreparedWordReviewPreview | undefined) => {
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
      const oldest = cache.get(oldestKey); cache.delete(oldestKey); await evict(oldest);
    }
  };

  return {
    async prepare(snapshot: WordReviewSnapshot): Promise<PreparedWordReviewPreview> {
      await assertPrivateRoot(artifactRoot);
      const settings = safeSettings(snapshot);
      let workDir: string | null = null;
      let keep = false;
      try {
        workDir = await mkdtemp(join(artifactRoot, 'word-review-'));
        await chmod(workDir, 0o700);
        const result = await runCli(snapshot, workDir, python, allowWordLaunch);
        const exactKeys = Object.keys(result).sort().join(',');
        if (exactKeys !== OUTPUT_KEYS || result.schema !== CLI_SCHEMA || result.preview_schema !== PREVIEW_SCHEMA ||
            (result.status !== 'REVIEW_REQUIRED' && result.status !== 'NEEDS_HUMAN') ||
            typeof result.reason_code !== 'string' || !REASON.test(result.reason_code) ||
            result.source_format !== 'DOCX' || result.print_source_format !== 'DOCX' ||
            result.ready !== false || result.allowed_to_print !== false || result.allowed_to_simulate !== false ||
            result.requires_staff_review !== true || result.physical_print_verified !== false ||
            !Array.isArray(result.preview_artifacts)) throw invalid();
        const nullableAnchors: Array<[unknown, unknown]> = [
          [result.shop_id, snapshot.shop_id], [result.order_id, snapshot.order_id],
          [result.active_revision, snapshot.active_revision], [result.request_hash, snapshot.request_hash],
          [result.source_sha256, snapshot.source.sha256], [result.source_size_bytes, snapshot.source.size_bytes],
          [result.input_manifest_sha256, snapshot.manifest.sha256]
        ];
        if (nullableAnchors.some(([got, expected]) => got !== null && got !== expected)) throw invalid();

        const base = {
          schema: 'ai0.word_review_preview.v1' as const,
          shop_id: snapshot.shop_id, order_id: snapshot.order_id,
          revision: snapshot.active_revision, request_hash: snapshot.request_hash,
          source_sha256: snapshot.source.sha256, manifest_sha256: snapshot.manifest.sha256,
          pages: [] as WordReviewPageDto[], ready: false as const,
          allowed_to_print: false as const, requires_staff_review: true as const,
          physical_print_verified: false as const
        };
        if (result.status === 'NEEDS_HUMAN') {
          if (result.preview_artifacts.length !== 0 || result.artifact_ref !== null || result.manifest_sha256 !== null)
            throw invalid();
          return { projection: { ...base, status: 'NEEDS_HUMAN', reason_code: result.reason_code },
            shop_id: snapshot.shop_id, order_id: snapshot.order_id, revision: snapshot.active_revision,
            request_hash: snapshot.request_hash, source_sha256: snapshot.source.sha256,
            source_manifest_sha256: snapshot.manifest.sha256, private_work_dir: null, private_bundle_ref: null,
            private_pages: [], expires_at: Date.now() + CACHE_TTL_MS };
        }

        if (result.native_word_verified !== true || !HEX.test(String(result.source_sha256)) ||
            result.source_sha256 !== snapshot.source.sha256 || result.source_size_bytes !== snapshot.source.size_bytes ||
            result.input_manifest_sha256 !== snapshot.manifest.sha256 || !safeRef(result.artifact_ref) ||
            !result.artifact_ref.endsWith('/manifest.json') || !HEX.test(String(result.manifest_sha256)) ||
            !HEX.test(String(result.settings_sha256)) || !Array.isArray(result.preview_artifacts) ||
            result.preview_artifacts.length < 1 || result.preview_artifacts.length > 3 ||
            !Number.isSafeInteger(result.document_pages) || Number(result.document_pages) < 1 ||
            Number(result.document_pages) > 500 || !Number.isSafeInteger(result.printed_faces) ||
            Number(result.printed_faces) < 1 || !Number.isSafeInteger(result.physical_sheets) ||
            Number(result.physical_sheets) < 1 || Number(result.physical_sheets) > Number(result.printed_faces) ||
            typeof result.requires_price_confirmation !== 'boolean' || !isRecord(result.renderer_identity) ||
            Object.keys(result.renderer_identity).sort().join(',') !== 'engine,version' ||
            result.renderer_identity.engine !== 'microsoft_word_com' || typeof result.renderer_identity.version !== 'string' ||
            !VERSION.test(result.renderer_identity.version)) throw invalid();

        const bundleRef = result.artifact_ref;
        const bundleFolder = bundleRef.split('/')[0];
        const manifestBytes = await readPrivateArtifact(workDir!, bundleRef, MAX_MANIFEST_BYTES);
        if (sha(manifestBytes) !== result.manifest_sha256) throw invalid();
        const manifest = parseJsonNoDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
        const expectedSettingsSha = sha(canonical(settings));
        if (!isRecord(manifest) || Object.keys(manifest).sort().join(',') !==
            'active_revision,allowed_to_print,counts,evidence_kind,files,input_manifest,order_id,paper_plan,physical_print_verified,previews,renderer_identity,request_hash,requires_staff_review,revision,ready,settings_sha256,schema,shop_id,source' ||
            manifest.schema !== PREVIEW_SCHEMA || manifest.shop_id !== snapshot.shop_id ||
            manifest.order_id !== snapshot.order_id || manifest.active_revision !== snapshot.active_revision ||
            manifest.revision !== snapshot.active_revision || manifest.request_hash !== snapshot.request_hash ||
            canonical(manifest.source) !== canonical(snapshot.source) ||
            canonical(manifest.input_manifest) !== canonical(snapshot.manifest) ||
            manifest.ready !== false || manifest.allowed_to_print !== false ||
            manifest.requires_staff_review !== true || manifest.physical_print_verified !== false ||
            manifest.evidence_kind !== 'windows_word_com_preview_only' ||
            canonical(manifest.renderer_identity) !== canonical(result.renderer_identity) ||
            manifest.settings_sha256 !== result.settings_sha256 || result.settings_sha256 !== expectedSettingsSha ||
            !Array.isArray(manifest.files) || manifest.files.length !== 1 || !Array.isArray(manifest.previews) ||
            manifest.previews.length !== result.preview_artifacts.length || !Array.isArray(manifest.paper_plan) ||
            manifest.paper_plan.length !== 1 || !isRecord(manifest.counts)) throw invalid();

        const file = manifest.files[0];
        if (!isRecord(file) || Object.keys(file).sort().join(',') !==
            'document_pages,file_sha256,physical_sheets,printed_faces,render_method,settings_sha256,size_bytes,source_artifact_ref' ||
            !safeRef(file.source_artifact_ref) || file.source_artifact_ref.split('/')[0] !== bundleFolder ||
            file.source_artifact_ref !== `${bundleFolder}/source-000-${snapshot.source.sha256}.docx` ||
            file.file_sha256 !== snapshot.source.sha256 || file.size_bytes !== snapshot.source.size_bytes ||
            file.settings_sha256 !== expectedSettingsSha || file.document_pages !== result.document_pages ||
            file.printed_faces !== result.printed_faces || file.physical_sheets !== result.physical_sheets ||
            file.render_method !== 'word_com_native_preview_only') throw invalid();
        const copiedSource = await readPrivateArtifact(workDir!, file.source_artifact_ref, MAX_SOURCE_BYTES);
        if (copiedSource.length !== snapshot.source.size_bytes || sha(copiedSource) !== snapshot.source.sha256) throw invalid();
        const counts = manifest.counts as Record<string, unknown>;
        if (counts.document_pages !== result.document_pages || counts.printed_faces !== result.printed_faces ||
            counts.physical_sheets !== result.physical_sheets ||
            counts.requires_price_confirmation !== result.requires_price_confirmation) throw invalid();

        const privatePages: CachedPage[] = [], publicPages: WordReviewPageDto[] = [];
        for (let index = 0; index < result.preview_artifacts.length; index++) {
          const page = result.preview_artifacts[index] as CliPage;
          const manifestPage = manifest.previews[index];
          const pageMatch = typeof page?.artifact_ref === 'string' ? /-p([1-9]\d*)\.png$/.exec(page.artifact_ref) : null;
          const pageIndex = pageMatch ? Number(pageMatch[1]) : 0;
          if (!page || Object.keys(page as object).sort().join(',') !== 'artifact_ref,sha256,size_bytes' ||
              !safeRef(page.artifact_ref) || page.artifact_ref.split('/')[0] !== bundleFolder ||
              !page.artifact_ref.endsWith('.png') || !HEX.test(page.sha256) ||
              !Number.isSafeInteger(page.size_bytes) || page.size_bytes < 1 || page.size_bytes > MAX_PAGE_BYTES ||
              !Number.isSafeInteger(pageIndex) || pageIndex < 1 || pageIndex > Number(result.document_pages) ||
              privatePages.some(existing => existing.index === pageIndex) || !isRecord(manifestPage) ||
              Object.keys(manifestPage).sort().join(',') !== 'bytes,ref,sha256' ||
              manifestPage.ref !== page.artifact_ref || manifestPage.sha256 !== page.sha256 ||
              manifestPage.bytes !== page.size_bytes) throw invalid();
          const pageBytes = await readPrivateArtifact(workDir!, page.artifact_ref, MAX_PAGE_BYTES);
          if (pageBytes.length !== page.size_bytes || sha(pageBytes) !== page.sha256 ||
              !pageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
          privatePages.push({ artifact_ref: page.artifact_ref, sha256: page.sha256,
            size_bytes: page.size_bytes, index: pageIndex });
          publicPages.push({ index: pageIndex, url: `/api/v1/orders/${encodeURIComponent(snapshot.order_id)}`+
            `/word-preview/pages/${pageIndex}`, content_type: 'image/png', sha256: page.sha256, bytes: page.size_bytes });
        }
        const prepared = { projection: { ...base, status: 'REVIEW_REQUIRED' as const,
          reason_code: result.reason_code as string,
          pages: publicPages, document_pages: Number(result.document_pages),
          printed_faces: Number(result.printed_faces), physical_sheets: Number(result.physical_sheets), settings },
          shop_id: snapshot.shop_id, order_id: snapshot.order_id, revision: snapshot.active_revision,
          request_hash: snapshot.request_hash, source_sha256: snapshot.source.sha256,
          source_manifest_sha256: snapshot.manifest.sha256, private_work_dir: workDir,
          private_bundle_ref: bundleRef, private_pages: privatePages, expires_at: Date.now() + CACHE_TTL_MS };
        keep = true;
        return prepared;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw unavailable();
      } finally {
        if (!keep) await removeWorkDirectory(artifactRoot, workDir);
      }
    },

    async remember(prepared: PreparedWordReviewPreview): Promise<void> {
      if (!prepared.private_work_dir || !prepared.private_pages.length) return;
      await prune();
      const entryKey = key(prepared.shop_id, prepared.order_id, prepared.revision);
      const previous = cache.get(entryKey);
      cache.delete(entryKey); cache.set(entryKey, prepared);
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

    async discard(prepared: PreparedWordReviewPreview): Promise<void> {
      const entryKey = key(prepared.shop_id, prepared.order_id, prepared.revision);
      if (cache.get(entryKey) === prepared) cache.delete(entryKey);
      await evict(prepared);
    },

    async find(shopId: string, orderId: string, revision: number): Promise<PreparedWordReviewPreview | null> {
      await prune();
      const entry = cache.get(key(shopId, orderId, revision));
      return entry && entry.expires_at > Date.now() ? entry : null;
    },

    async readPage(entry: PreparedWordReviewPreview, index: number): Promise<Buffer> {
      const page = entry.private_pages.find(candidate => candidate.index === index);
      if (!entry.private_work_dir || !page || !Number.isSafeInteger(index) || index < 1)
        throw new DomainError('NOT_FOUND', 'Preview không tồn tại', 404);
      const bytes = await readPrivateArtifact(entry.private_work_dir, page.artifact_ref, MAX_PAGE_BYTES);
      if (bytes.length !== page.size_bytes || sha(bytes) !== page.sha256 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
      return bytes;
    }
  };
}
