import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonical, sha, type PrintPlan } from '../../../backend/core/model.js';
import { checkedEvidence, type PrintEvidenceScope, type PrintEvidenceV1 } from '../../../backend/core/print-evidence.js';
import type { SqlConnection } from '../../../backend/storage/database.js';
import { createTrustedPrintEvidencePort } from '../../../backend/composition/trusted-print-evidence.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonDigest = (value: unknown) => sha(canonical(value));

test('TypeScript evidence validator accepts the shared Python/Core canonical vector', async () => {
  const fixture = JSON.parse(await readFile(new URL(
    '../../unit/documents/fixtures/print_evidence_v1_core_vector.json', import.meta.url), 'utf8')) as {
      scope: PrintEvidenceScope;
      proof: PrintEvidenceV1;
      expected_sha256: { plan_sha256: string; source_set_sha256: string; evidence_sha256: string };
      processor_counts: Record<string, number>;
      synthetic_only: boolean;
    };
  assert.equal(fixture.synthetic_only, true);
  assert.equal(fixture.proof.plan_sha256, fixture.expected_sha256.plan_sha256);
  assert.equal(fixture.proof.source_set_sha256, fixture.expected_sha256.source_set_sha256);
  assert.equal(fixture.proof.evidence_sha256, fixture.expected_sha256.evidence_sha256);
  assert.deepEqual(fixture.processor_counts, {
    document_pages: fixture.scope.plan.document_pages,
    printed_faces: fixture.scope.plan.printed_faces,
    physical_sheets: fixture.scope.plan.physical_sheets,
  });
  assert.equal(checkedEvidence(fixture.scope, fixture.proof), fixture.expected_sha256.evidence_sha256);
});

test('trusted print evidence is reconstructed from DB-bound PDF, manifest and preview bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoin-trusted-print-evidence-'));
  try {
    const folder = 'doc-evidence0001';
    await mkdir(join(root, folder), { mode: 0o700 });
    const manifestRef = `${folder}/manifest.json`;
    const source = Buffer.from('%PDF-1.7\nsynthetic source bytes\n');
    const sourceSha = digest(source);
    const fixedSourceRef = `${folder}/source-000-${sourceSha}.pdf`;
    const preview = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    const previewSha = digest(preview);
    const fixedPreviewRef = `${folder}/${sourceSha.slice(0, 16)}-0-p1.png`;
    const requestData = { documents: [{ artifact_name: 'doc-inbound0001/source-000-' + sourceSha + '.pdf',
      copies: 1, duplex: false, paper: 'A4' }] };
    const requestHash = jsonDigest(requestData);
    const settings = { copies: 1, duplex: false, paper: 'A4' };
    const planFile = { file_sha256: sourceSha, document_pages: 1, selected_pages: [1], copies: 1,
      duplex: false, paper: 'A4', orientation: 'portrait', binding: 'long_edge',
      scale_mode: 'shrink_to_printable_area_only', printed_faces: 1, physical_sheets: 1,
      separate_each_file_and_copy: true };
    const counts = { document_pages: 1, printed_faces: 1, physical_sheets: 1,
      requires_price_confirmation: false };
    const renderer = { pymupdf: 'synthetic-vector-1', pillow: 'synthetic-vector-1' };
    const file = { source_artifact_ref: fixedSourceRef, file_sha256: sourceSha,
      size_bytes: source.length, settings_sha256: jsonDigest(settings),
      render_method: 'pymupdf-synthetic', document_pages: 1,
      printed_faces: 1, physical_sheets: 1, warnings: [] };
    const previewEntry = { ref: fixedPreviewRef, sha256: previewSha, bytes: preview.length };
    const stable = { request_hash: requestHash, renderer_versions: renderer,
      files: [{ file_sha256: sourceSha, size_bytes: source.length,
        settings_sha256: jsonDigest(settings), render_method: 'pymupdf-synthetic',
        document_pages: 1, printed_faces: 1, physical_sheets: 1, warnings: [] }],
      preview_sha256: [previewSha], counts, paper_plan: [planFile] };
    const manifest = { schema: 'ai3.document_bridge.v1', request_hash: requestHash,
      renderer_versions: renderer, files: [file], previews: [previewEntry],
      counts, paper_plan: [planFile], content_settings_sha256: jsonDigest(stable),
      evidence_kind: 'local_render_verified_artifacts' };
    const manifestBytes = Buffer.from(canonical(manifest), 'utf8');
    const manifestSha = digest(manifestBytes);
    await writeFile(join(root, folder, `source-000-${sourceSha}.pdf`), source, { mode: 0o400 });
    await writeFile(join(root, folder, fixedPreviewRef.split('/')[1]!), preview, { mode: 0o400 });
    await writeFile(join(root, folder, 'manifest.json'), manifestBytes, { mode: 0o400 });

    const plan: PrintPlan = { request_hash: requestHash, physical_sheets: 1,
      document_pages: 1, printed_faces: 1, ready: true, printer_id: 'RMP7000',
      artifact_ref: manifestRef, verified_by: 'ai3.document_bridge.v1' };
    const scope: PrintEvidenceScope = { shop_id: 'synthetic-shop', order_id: '00000000-0000-4000-8000-000000000001',
      revision: 1, request_hash: requestHash, plan };
    const row = { active_revision: 1, mode: 'simulation', request_hash: requestHash,
      request_data: requestData, plan, manifest_ref: manifestRef, manifest_sha256: manifestSha };
    const db = { query: async <T>() => ({ rows: [row as T], rowCount: 1 }), release() {} } as SqlConnection;
    const port = createTrustedPrintEvidencePort({ artifactRoot: root,
      printerCapabilities: { simulation_only: true, printer_id: 'RMP7000', queue_name: 'RMP7000' } });

    const proof = await port.read_verified(db, scope);
    assert.ok(proof);
    assert.equal(checkedEvidence(scope, proof), proof.evidence_sha256);
    assert.deepEqual(proof.sources, [{ source_artifact_ref: fixedSourceRef, format: 'PDF',
      size_bytes: source.length, source_sha256: sourceSha }]);
    assert.equal(proof.plan_sha256, jsonDigest(plan));

    const manifestPath = join(root, folder, 'manifest.json');
    const sourcePath = join(root, folder, `source-000-${sourceSha}.pdf`);
    const replaceReadOnly = async (path: string, bytes: Buffer) => {
      await chmod(path, 0o600);
      await writeFile(path, bytes);
      await chmod(path, 0o400);
    };
    const wrongSettingsPlan = { ...planFile, paper: 'A3' };
    const wrongSettingsStable = { ...stable, paper_plan: [wrongSettingsPlan] };
    const wrongSettingsManifest = { ...manifest, paper_plan: [wrongSettingsPlan],
      content_settings_sha256: jsonDigest(wrongSettingsStable) };
    const wrongSettingsBytes = Buffer.from(canonical(wrongSettingsManifest), 'utf8');
    await replaceReadOnly(manifestPath, wrongSettingsBytes);
    row.manifest_sha256 = digest(wrongSettingsBytes);
    assert.equal(await port.read_verified(db, scope), null,
      'self-consistent manifest still fails if its print plan differs from the request');

    await replaceReadOnly(manifestPath, manifestBytes);
    row.manifest_sha256 = manifestSha;
    await replaceReadOnly(sourcePath, Buffer.from('%PDF-mutated'));
    assert.equal(await port.read_verified(db, scope), null, 'mutated original bytes fail closed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted print evidence binds native DOCX and preview while retaining the staff-review hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoin-trusted-word-evidence-'));
  try {
    const folder = 'doc-wordevidence01';
    await mkdir(join(root, folder), { mode: 0o700 });
    // Tiny valid OOXML zip with [Content_Types].xml and word/document.xml.
    const source = Buffer.from('504b03041400000008005b73515df74b8075c200000076010000130000005b436f6e74656e745f54797065735d2e786d6c7d90b90ec2300c865fa5ca8aa8110303a22cc00a0cbc8095ba6d442ec52ec7db93720d0818edfff82c2f0ed7485c5c9cf55ca94e24ce015877e490cb10c967a509c9a1e431b510511fb125984e2633d0c10b7919cbd0a1968b3535d85b293697bc66137ca5125956c5ea611c5895c218add128598793af3f28e327a1ccc9bb873b1379940d0abe1206e537e099db9d28255353b1c7245b74d905e7906aa883ee5d4e96ff6bbedc199ac6687ae787b698822666e35b67cbb7e2d0f8d7fd707ff7f206504b03041400000008005b73515d9e3a674881000000ae00000011000000776f72642f646f63756d656e742e786d6c458e4b0e83300c05af8238408dbae8224a73865e81268644221fd94681db43d2453763799e653d5d95cb768f986438e29658d5f7e8458a0260eb31cefcc805d39d2d99e22cf74a2bd44cae50b6c81cd21a37784ed30be21cd2687455dfecce364b033588e1338947097658c2213ba186a61ba9b31f335af91074f1fb02ff86e602504b010214031400000008005b73515df74b8075c2000000760100001300000000000000000000008001000000005b436f6e74656e745f54797065735d2e786d6c504b010214031400000008005b73515d9e3a674881000000ae0000001100000000000000000000008001f3000000776f72642f646f63756d656e742e786d6c504b0506000000000200020080000000a30100000000', 'hex');
    const sourceSha = digest(source);
    const manifestRef = `${folder}/manifest.json`;
    const sourceRef = `${folder}/source-000-${sourceSha}.docx`;
    const preview = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    const previewSha = digest(preview);
    const previewRef = `${folder}/${sourceSha.slice(0, 16)}-0-p1.png`;
    const requestData = { documents: [{ artifact_name: 'incoming/minimal.docx', copies: 1,
      duplex: false, paper: 'A4', orientation: 'portrait' }] };
    const requestHash = jsonDigest(requestData);
    const settings = { copies: 1, duplex: false, paper: 'A4', orientation: 'portrait' };
    const paperPlan = { file_sha256: sourceSha, document_pages: 1, selected_pages: [1],
      copies: 1, duplex: false, paper: 'A4', orientation: 'portrait', binding: 'long_edge',
      scale_mode: 'shrink_to_printable_area_only', printed_faces: 1, physical_sheets: 1,
      separate_each_file_and_copy: true };
    const counts = { document_pages: 1, printed_faces: 1, physical_sheets: 1,
      requires_price_confirmation: false };
    const renderer = { engine: 'microsoft_word_com', version: '16.0' };
    const file = { source_artifact_ref: sourceRef, file_sha256: sourceSha, size_bytes: source.length,
      settings_sha256: jsonDigest(settings), render_method: 'word_com_native_preview_only',
      document_pages: 1, printed_faces: 1, physical_sheets: 1 };
    const manifest = { schema: 'ai3.native_word_preview.v1', revision: 1, request_hash: requestHash,
      files: [file], previews: [{ ref: previewRef, sha256: previewSha, bytes: preview.length }],
      paper_plan: [paperPlan], counts, evidence_kind: 'windows_word_com_preview_only',
      renderer_identity: renderer, ready: false, requires_staff_review: true,
      physical_print_verified: false };
    const manifestBytes = Buffer.from(canonical(manifest), 'utf8');
    const manifestSha = digest(manifestBytes);
    await writeFile(join(root, sourceRef), source, { mode: 0o400 });
    await writeFile(join(root, previewRef), preview, { mode: 0o400 });
    await writeFile(join(root, manifestRef), manifestBytes, { mode: 0o400 });
    const plan: PrintPlan = { request_hash: requestHash, physical_sheets: 1,
      document_pages: 1, printed_faces: 1, ready: true, printer_id: 'RMP7000',
      artifact_ref: manifestRef, verified_by: 'ai3.native_word_preview.v1' };
    const scope: PrintEvidenceScope = { shop_id: 'synthetic-shop',
      order_id: '00000000-0000-4000-8000-000000000002', revision: 1, request_hash: requestHash, plan };
    const row = { active_revision: 1, mode: 'simulation', request_hash: requestHash,
      request_data: requestData, plan, manifest_ref: manifestRef, manifest_sha256: manifestSha };
    const db = { query: async <T>() => ({ rows: [row as T], rowCount: 1 }), release() {} } as SqlConnection;
    const port = createTrustedPrintEvidencePort({ artifactRoot: root,
      printerCapabilities: { simulation_only: true, printer_id: 'RMP7000', queue_name: 'RMP7000' } });

    const proof = await port.read_verified(db, scope);
    assert.ok(proof);
    assert.equal(proof.sources[0]?.format, 'DOCX');
    assert.equal(proof.sources[0]?.source_sha256, sourceSha);
    assert.equal(proof.renderer_sha256, jsonDigest(renderer));
    assert.equal(checkedEvidence(scope, proof), proof.evidence_sha256);

    const wrongReadyManifest = Buffer.from(canonical({ ...manifest, ready: true }), 'utf8');
    const manifestPath = join(root, manifestRef);
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, wrongReadyManifest);
    await chmod(manifestPath, 0o400);
    row.manifest_sha256 = digest(wrongReadyManifest);
    assert.equal(await port.read_verified(db, scope), null,
      'a native Word manifest may provide evidence for review only while ready=false and staff review is required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
