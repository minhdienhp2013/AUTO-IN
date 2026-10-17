import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { canonical, type PrintPlan } from '../core/model.js';
import type { PrintEvidenceScope, PrintEvidenceV1, TrustedPrintEvidencePort } from '../core/print-evidence.js';
import type { SqlConnection } from '../storage/database.js';

const MANIFEST_REF = /^doc-[A-Za-z0-9_-]{6,64}\/manifest\.json$/;
const SOURCE_REF = /^doc-[A-Za-z0-9_-]{6,64}\/source-\d{3}-([a-f0-9]{64})\.pdf$/;
const PREVIEW_REF = /^doc-[A-Za-z0-9_-]{6,64}\/([a-f0-9]{16})-(\d+)-p([1-9]\d*)\.png$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST = 256 * 1024;
const MAX_SOURCE = 25 * 1024 * 1024;
const MAX_PREVIEW = 10 * 1024 * 1024;
const hashBytes = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const hashJson = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === 'number' && value > 0;

interface EvidenceRow {
  active_revision: number;
  mode: string;
  request_hash: string;
  request_data: unknown;
  plan: PrintPlan | null;
  manifest_ref: string;
  manifest_sha256: string;
}
interface ManifestFile {
  source_artifact_ref?: unknown;
  file_sha256?: unknown;
  size_bytes?: unknown;
  settings_sha256?: unknown;
  document_pages?: unknown;
  printed_faces?: unknown;
  physical_sheets?: unknown;
  render_method?: unknown;
}
interface ManifestPreview { ref?: unknown; sha256?: unknown; bytes?: unknown }

/**
 * Only a synthetic capability profile may be installed by the current
 * simulation runtime. It is deliberately insufficient evidence for a real
 * Windows/Ricoh device; that needs a separate authenticated device adapter.
 */
export interface SimulationPrinterCapabilitySnapshot extends Record<string, unknown> {
  simulation_only: true;
  printer_id: 'RMP7000';
  queue_name: 'RMP7000';
}

export interface TrustedPrintEvidenceOptions {
  artifactRoot: string;
  printerCapabilities: SimulationPrinterCapabilitySnapshot;
}

function checkedPath(root: string, ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.includes('..') || ref.includes('\\') || ref.includes('\0')) return null;
  if (!(MANIFEST_REF.test(ref) || SOURCE_REF.test(ref) || PREVIEW_REF.test(ref))) return null;
  const target = resolve(root, ref);
  return target.startsWith(resolve(root) + sep) ? target : null;
}

async function readArtifact(root: string, ref: unknown, limit: number): Promise<Buffer | null> {
  const target = checkedPath(root, ref);
  if (!target) return null;
  const rootInfo = await lstat(root).catch(() => null);
  const dirInfo = await lstat(resolve(root, String(ref).split('/')[0]!)).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022) ||
      !dirInfo?.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o022)) return null;
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) return null;
    const bytes = await handle.readFile();
    return bytes.length === info.size ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function settingsFor(requestData: unknown): Record<string, unknown>[] | null {
  const request = record(requestData);
  const documents = request?.documents;
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 5) return null;
  const allowed = new Set(['artifact_name', 'copies', 'duplex', 'paper', 'orientation', 'binding', 'page_range']);
  const settings: Record<string, unknown>[] = [];
  for (const item of documents) {
    const document = record(item);
    if (!document || typeof document.artifact_name !== 'string' ||
        Object.keys(document).some(key => !allowed.has(key))) return null;
    const next = { ...document };
    delete next.artifact_name;
    settings.push(next);
  }
  return settings;
}

function validCorePlan(plan: PrintPlan | null, scope: Readonly<PrintEvidenceScope>, manifestRef: string,
  counts: Record<string, unknown>): plan is PrintPlan {
  return !!plan && plan.ready === true && plan.request_hash === scope.request_hash &&
    plan.artifact_ref === manifestRef && plan.printer_id === 'RMP7000' &&
    positiveInt(plan.document_pages) && positiveInt(plan.printed_faces) && positiveInt(plan.physical_sheets) &&
    counts.document_pages === plan.document_pages && counts.printed_faces === plan.printed_faces &&
    counts.physical_sheets === plan.physical_sheets &&
    counts.requires_price_confirmation === (plan.physical_sheets > 150);
}

function expectedPaperPlan(file: ManifestFile, setting: Record<string, unknown>): Record<string, unknown> | null {
  const documentPages = file.document_pages;
  if (!positiveInt(documentPages) || documentPages > 500 || typeof file.file_sha256 !== 'string') return null;
  const value = (key: string, fallback: unknown) =>
    Object.hasOwn(setting, key) ? setting[key] : fallback;
  const copies = value('copies', 1);
  const duplex = value('duplex', false);
  const paper = value('paper', 'A4');
  const orientation = value('orientation', 'portrait');
  const binding = value('binding', 'long_edge');
  const expression = value('page_range', null);
  if (!Number.isSafeInteger(copies) || typeof copies !== 'number' || copies < 1 || copies > 999 ||
      typeof duplex !== 'boolean' || (paper !== 'A4' && paper !== 'A3') ||
      (orientation !== 'portrait' && orientation !== 'landscape') ||
      (binding !== 'long_edge' && binding !== 'short_edge')) return null;
  const selectedPages: number[] = [];
  if (expression === null || expression === undefined || expression === 'all') {
    for (let page = 1; page <= documentPages; page++) selectedPages.push(page);
  } else {
    if (typeof expression !== 'string') return null;
    if (expression.toLowerCase() === 'all') {
      for (let page = 1; page <= documentPages; page++) selectedPages.push(page);
    } else {
      for (const chunk of expression.split(',')) {
        const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(chunk);
        if (!match) return null;
        const start = Number(match[1]);
        const end = match[2] === undefined ? start : Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 1 || end > documentPages || end < start) return null;
        for (let page = start; page <= end; page++) selectedPages.push(page);
      }
    }
  }
  if (!selectedPages.length || selectedPages.length > 500 ||
      new Set(selectedPages).size !== selectedPages.length) return null;
  const printedFaces = selectedPages.length * copies;
  const physicalSheets = (duplex ? Math.ceil(selectedPages.length / 2) : selectedPages.length) * copies;
  return {
    file_sha256: file.file_sha256,
    document_pages: documentPages,
    selected_pages: selectedPages,
    copies,
    duplex,
    paper,
    orientation,
    binding,
    scale_mode: 'shrink_to_printable_area_only',
    printed_faces: printedFaces,
    physical_sheets: physicalSheets,
    separate_each_file_and_copy: true,
  };
}

/**
 * Builds the Core evidence tuple from DB-pinned revision rows and actual bytes
 * under the private artifact root. It currently accepts only AI3's verified
 * PDF bridge manifest. Native Word remains held until AI3 publishes a reviewed
 * native Word gate that the Core transaction can authenticate.
 */
export function createTrustedPrintEvidencePort(options: TrustedPrintEvidenceOptions): TrustedPrintEvidencePort {
  if (!options || typeof options.artifactRoot !== 'string' || !options.artifactRoot ||
      options.printerCapabilities?.simulation_only !== true ||
      options.printerCapabilities.printer_id !== 'RMP7000' ||
      options.printerCapabilities.queue_name !== 'RMP7000') {
    throw new Error('SIMULATION_PRINT_EVIDENCE_CONFIG_REQUIRED');
  }
  const root = resolve(options.artifactRoot);
  const capabilities = Object.freeze({ ...options.printerCapabilities });

  return {
    async read_verified(db: SqlConnection, scope: Readonly<PrintEvidenceScope>): Promise<PrintEvidenceV1 | null> {
      try {
        const result = await db.query<EvidenceRow>(
          'SELECT o.active_revision,s.mode,r.request_hash,r.request_data,r.plan,' +
          'e.artifact_ref AS manifest_ref,e.manifest_sha256::text AS manifest_sha256 ' +
          'FROM core_orders o ' +
          'JOIN core_shop_settings s ON s.shop_id=o.shop_id ' +
          'JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision ' +
          'JOIN ai0_verified_plan_manifests e ON e.shop_id=o.shop_id AND e.order_id=o.id ' +
          'AND e.revision=r.revision AND e.request_hash=r.request_hash ' +
          'WHERE o.shop_id=$1 AND o.id=$2 AND o.active_revision=$3',
          [scope.shop_id, scope.order_id, scope.revision]);
        const row = result.rows[0];
        if (!row || result.rows.length !== 1 || row.mode !== 'simulation' ||
            row.active_revision !== scope.revision || row.request_hash.trim() !== scope.request_hash ||
            !SHA256.test(row.request_hash.trim()) || !SHA256.test(row.manifest_sha256.trim()) ||
            row.plan === null || canonical(row.plan) !== canonical(scope.plan) ||
            row.plan.printer_id !== capabilities.printer_id || row.plan.artifact_ref !== row.manifest_ref ||
            !MANIFEST_REF.test(row.manifest_ref)) return null;

        const manifestBytes = await readArtifact(root, row.manifest_ref, MAX_MANIFEST);
        if (!manifestBytes || hashBytes(manifestBytes) !== row.manifest_sha256.trim()) return null;
        let manifestValue: unknown;
        try { manifestValue = JSON.parse(manifestBytes.toString('utf8')); }
        catch { return null; }
        const manifest = record(manifestValue);
        // AI3 writes canonical compact JSON. Requiring byte-canonical input also
        // rejects duplicate-key JSON that JSON.parse would otherwise collapse.
        if (!manifest || Buffer.from(canonical(manifest), 'utf8').compare(manifestBytes) !== 0 ||
            manifest.schema !== 'ai3.document_bridge.v1' || manifest.request_hash !== scope.request_hash ||
            !Array.isArray(manifest.files) || !Array.isArray(manifest.previews) ||
            manifest.files.length < 1 || manifest.files.length > 5 ||
            manifest.previews.length < 1 || manifest.previews.length > 15) return null;

        const settings = settingsFor(row.request_data);
        if (!settings || settings.length !== manifest.files.length) return null;
        const counts = record(manifest.counts);
        const renderer = record(manifest.renderer_versions);
        const paperPlan = manifest.paper_plan;
        if (!counts || !renderer || !Object.keys(renderer).length ||
            !Array.isArray(paperPlan) || paperPlan.length !== manifest.files.length ||
            !validCorePlan(row.plan, scope, row.manifest_ref, counts)) return null;

        const sources: PrintEvidenceV1['sources'] = [];
        const expectedPlans: Record<string, unknown>[] = [];
        for (let index = 0; index < manifest.files.length; index++) {
          const file = record(manifest.files[index]) as ManifestFile | null;
          const ref = file?.source_artifact_ref;
          const match = typeof ref === 'string' ? SOURCE_REF.exec(ref) : null;
          const pagePlan = record(paperPlan[index]);
          const expectedPlan = file && settings[index] ? expectedPaperPlan(file, settings[index]!) : null;
          if (!file || typeof ref !== 'string' || !match || typeof file.file_sha256 !== 'string' ||
              !SHA256.test(file.file_sha256) || match[1] !== file.file_sha256 ||
              !positiveInt(file.size_bytes) || !positiveInt(file.document_pages) ||
              !positiveInt(file.printed_faces) || !positiveInt(file.physical_sheets) ||
              !pagePlan || pagePlan.file_sha256 !== file.file_sha256 ||
              !expectedPlan || canonical(pagePlan) !== canonical(expectedPlan) ||
              pagePlan.document_pages !== file.document_pages ||
              pagePlan.printed_faces !== file.printed_faces ||
              pagePlan.physical_sheets !== file.physical_sheets ||
              typeof file.settings_sha256 !== 'string' ||
              file.settings_sha256 !== hashJson(settings[index])) return null;
          const raw = await readArtifact(root, ref, MAX_SOURCE);
          if (!raw || raw.length !== file.size_bytes || hashBytes(raw) !== file.file_sha256 ||
              !raw.subarray(0, 5).equals(Buffer.from('%PDF-'))) return null;
          sources.push({ source_artifact_ref: ref, format: 'PDF',
            size_bytes: raw.length, source_sha256: hashBytes(raw) });
          expectedPlans.push(expectedPlan);
        }
        const expectedCounts = {
          document_pages: expectedPlans.reduce((n, p) => n + Number(p.document_pages), 0),
          printed_faces: expectedPlans.reduce((n, p) => n + Number(p.printed_faces), 0),
          physical_sheets: expectedPlans.reduce((n, p) => n + Number(p.physical_sheets), 0),
        };
        if (counts.document_pages !== expectedCounts.document_pages ||
            counts.printed_faces !== expectedCounts.printed_faces ||
            counts.physical_sheets !== expectedCounts.physical_sheets ||
            counts.requires_price_confirmation !== (expectedCounts.physical_sheets > 150)) return null;

        const previews: PrintEvidenceV1['previews'] = [];
        const previewHashes: string[] = [];
        const previewRefs = new Set<string>();
        const previewsBySource = sources.map(() => 0);
        for (let index = 0; index < manifest.previews.length; index++) {
          const preview = record(manifest.previews[index]) as ManifestPreview | null;
          const match = typeof preview?.ref === 'string' ? PREVIEW_REF.exec(preview.ref) : null;
          const sourceIndex = match ? Number(match[2]) : -1;
          const page = match ? Number(match[3]) : -1;
          const sourcePageCount = expectedPlans[sourceIndex]?.document_pages;
          if (!preview || typeof preview.ref !== 'string' || !match ||
              sourceIndex < 0 || sourceIndex >= sources.length ||
              match[1] !== sources[sourceIndex]?.source_sha256.slice(0, 16) ||
              typeof sourcePageCount !== 'number' || page > sourcePageCount ||
              previewRefs.has(preview.ref) ||
              typeof preview.sha256 !== 'string' || !SHA256.test(preview.sha256) ||
              !positiveInt(preview.bytes) || preview.bytes < 8 || preview.bytes > MAX_PREVIEW) return null;
          const raw = await readArtifact(root, preview.ref, MAX_PREVIEW);
          if (!raw || raw.length !== preview.bytes || hashBytes(raw) !== preview.sha256 ||
              !raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
          previews.push({ index, bytes: raw.length, sha256: hashBytes(raw) });
          previewHashes.push(hashBytes(raw));
          previewRefs.add(preview.ref);
          previewsBySource[sourceIndex] = previewsBySource[sourceIndex]! + 1;
        }
        if (previewsBySource.some(count => count < 1 || count > 3)) return null;

        const filesWithoutRefs = manifest.files.map(value => {
          const file = record(value);
          if (!file) return null;
          const { source_artifact_ref: _source, ...rest } = file;
          return rest;
        });
        const stableManifestProof = {
          request_hash: scope.request_hash,
          renderer_versions: renderer,
          files: filesWithoutRefs,
          preview_sha256: previewHashes,
          counts,
          paper_plan: paperPlan,
        };
        if (typeof manifest.content_settings_sha256 !== 'string' ||
            manifest.content_settings_sha256 !== hashJson(stableManifestProof)) return null;

        const body = {
          schema: 'ai0.print_evidence.v1' as const,
          shop_id: scope.shop_id,
          order_id: scope.order_id,
          revision: scope.revision,
          request_hash: scope.request_hash,
          sources,
          source_set_sha256: hashJson(sources),
          settings_sha256: hashJson(settings),
          manifest_ref: row.manifest_ref,
          manifest_sha256: hashBytes(manifestBytes),
          previews,
          renderer_sha256: hashJson(renderer),
          plan_sha256: hashJson(scope.plan),
          printer_id: 'RMP7000',
          printer_capability_sha256: hashJson(capabilities),
        };
        return { ...body, evidence_sha256: hashJson(body) };
      } catch {
        // A damaged file, permissions error or malformed DB row is a review
        // hold. Never turn verifier exceptions into evidence.
        return null;
      }
    }
  };
}
