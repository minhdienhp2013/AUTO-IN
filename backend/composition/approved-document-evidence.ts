import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DomainError, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';

export interface ApprovedDocumentEvidenceOptions {
  artifactRoot: string;
  python?: string;
  timeoutMs?: number;
}
interface TrustedEvidenceRow {
  active_revision: number;
  approval_revision: number;
  request_hash: string;
  approval_id: string;
  manifest_ref: string;
  manifest_sha256: string;
  plan: unknown;
}
interface GateResult { status?: unknown; ready?: unknown }

const verifier = [
  'import json,sys',
  'from workers.documents.evidence_guard import verify_approved_evidence',
  'try:',
  '    trusted=json.load(sys.stdin)',
  '    result=verify_approved_evidence(trusted, artifact_root=sys.argv[1])',
  '    print(json.dumps({"status":result.get("status"),"ready":result.get("ready") is True},separators=(",",":")))',
  'except Exception:',
  '    print(json.dumps({"status":"NEEDS_HUMAN","ready":False},separators=(",",":")))',
  '    sys.exit(2)'
].join('\n');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function runVerifier(
  python: string, artifactRoot: string, trusted: TrustedEvidenceRow, timeoutMs: number
): Promise<boolean> {
  const input = Buffer.from(JSON.stringify(trusted), 'utf8');
  if (input.length > 256 * 1024) return false;
  return await new Promise<boolean>(resolve => {
    const child = spawn(python, ['-c', verifier, artifactRoot], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '', PYTHONPATH: process.cwd(), PYTHONNOUSERSITE: '1' }
    });
    let outputBytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.stdout.on('data', (part: Buffer) => {
      outputBytes += part.length;
      if (outputBytes > 16 * 1024) {
        child.kill('SIGKILL');
        finish(false);
      } else chunks.push(part);
    });
    child.on('error', () => finish(false));
    child.on('close', code => {
      if (finished) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as GateResult;
        finish(code === 0 && result.status === 'READY' && result.ready === true);
      } catch { finish(false); }
    });
    child.stdin.on('error', () => finish(false));
    child.stdin.end(input);
  });
}

/** Verify sealed AI3 bytes against server-trusted approval/revision/manifest rows.
 * The caller must first pass AI1's lease and print-job preflight; no client fields
 * are used for the shop, approval, plan, manifest ref, or manifest digest.
 */
export async function assertApprovedPrintJobEvidence(
  pool: SqlPool, actor: Principal,
  input: { jobId: string; expectedRevision: number; leaseToken: string },
  options?: ApprovedDocumentEvidenceOptions
): Promise<void> {
  if (!options?.artifactRoot)
    throw new DomainError('DOCUMENT_EVIDENCE_GATE_UNAVAILABLE',
      'Không thể xác minh bằng chứng tài liệu ở máy chủ', 503);
  if (!actor.verified || actor.role !== 'print_agent' || !actor.shop_id ||
      !/^[a-f0-9-]{36}$/i.test(input.jobId) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      typeof input.leaseToken !== 'string' || !input.leaseToken)
    throw new DomainError('DOCUMENT_EVIDENCE_UNVERIFIED',
      'Lệnh in không có bằng chứng tài liệu hợp lệ', 409);
  const result = await pool.query<TrustedEvidenceRow>(
    'SELECT o.active_revision,a.revision AS approval_revision,j.request_hash,a.id::text AS approval_id,' +
    'e.artifact_ref AS manifest_ref,e.manifest_sha256::text,r.plan ' +
    'FROM core_print_jobs j ' +
    'JOIN core_orders o ON o.id=j.order_id AND o.shop_id=$2 ' +
    'JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode=\'simulation\' ' +
    'JOIN core_revisions r ON r.order_id=j.order_id AND r.revision=j.revision ' +
    'JOIN core_approvals a ON a.id=j.approval_id AND a.order_id=j.order_id ' +
    'AND a.revision=j.revision AND a.request_hash=j.request_hash ' +
    'JOIN ai0_verified_plan_manifests e ON e.shop_id=o.shop_id AND e.order_id=o.id ' +
    'AND e.revision=j.revision AND e.request_hash=j.request_hash ' +
    'AND e.artifact_ref=r.plan->>\'artifact_ref\' ' +
    'WHERE j.id=$1 AND j.claimed_by=$3 AND j.state=\'NOT_SENT\' AND j.cancelled_at IS NULL ' +
    'AND j.revision=$4 AND o.active_revision=j.revision AND r.request_hash=j.request_hash ' +
    'AND j.lease_secret_hash=$5 AND j.lease_until>now() AND NOT o.manual_lock AND NOT o.print_closed',
    [input.jobId, actor.shop_id, actor.id, input.expectedRevision, sha256(input.leaseToken)]
  );
  if (result.rows.length !== 1) {
    throw new DomainError('DOCUMENT_EVIDENCE_UNVERIFIED',
      'Tài liệu của phiên bản đã duyệt không còn được xác minh', 409);
  }
  const row = result.rows[0]!;
  const trusted: TrustedEvidenceRow = {
    active_revision: row.active_revision,
    approval_revision: row.approval_revision,
    request_hash: row.request_hash.trim(),
    approval_id: row.approval_id,
    manifest_ref: row.manifest_ref,
    manifest_sha256: row.manifest_sha256.trim(),
    plan: row.plan
  };
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new DomainError('DOCUMENT_EVIDENCE_GATE_UNAVAILABLE',
      'Không thể xác minh bằng chứng tài liệu ở máy chủ', 503);
  }
  const ready = await runVerifier(options.python ?? 'python3', options.artifactRoot,
    trusted, timeoutMs).catch(() => false);
  if (!ready) {
    throw new DomainError('DOCUMENT_EVIDENCE_UNVERIFIED',
      'Tài liệu của phiên bản đã duyệt không còn được xác minh', 409);
  }
}
