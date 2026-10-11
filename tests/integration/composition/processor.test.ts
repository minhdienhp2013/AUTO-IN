import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, sha } from '../../../backend/core/model.js';
import { inspectDocumentRequest } from '../../../backend/composition/processor.js';

test('Node composition invokes AI3 CLI on synthetic image and verifies immutable source manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoin-processor-'));
  const input = join(root, 'input'), artifacts = join(root, 'artifacts');
  const python = process.env.AUTOIN_PYTHON ?? 'python3';
  try {
    await mkdir(input); await mkdir(artifacts);
    execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB", (320,480), "white").save(sys.argv[1])', join(input, 'synthetic.png')]);
    const request = { documents: [{ artifact_name: 'synthetic.png', copies: 2, duplex: false, paper: 'A4' }] };
    const hash = sha(canonical(request));
    const result = await inspectDocumentRequest(request, hash, { inputRoot: input, artifactRoot: artifacts, python });
    assert.equal(result.plan.request_hash, hash);
    assert.equal(result.plan.physical_sheets, 2);
    const manifest = JSON.parse(await readFile(join(artifacts, result.plan.artifact_ref), 'utf8'));
    assert.equal(manifest.files.length, 1);
    assert.match(manifest.files[0].source_artifact_ref, /\/source-000-[a-f0-9]{64}\.png$/);
    await assert.rejects(inspectDocumentRequest(request, 'f'.repeat(64),
      { inputRoot: input, artifactRoot: artifacts, python }), (error: any) => error.code === 'PROCESSOR_NEEDS_HUMAN');
  } finally { await rm(root, { recursive: true, force: true }); }
});
