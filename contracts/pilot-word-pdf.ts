/** Shared wire v0.1 for the owner-approved, shop-code Word/PDF pilot.
 * Types are descriptive only. Importing this file never enables real printing.
 */
export type PilotSourceFormat = 'DOCX' | 'PDF';
export type PilotPaper = 'A4';

/** Server-derived from verified OA events and sealed private storage. */
export interface PilotWordPdfCandidate {
  readonly shop_id: string;
  readonly oa_id: string;
  readonly customer_id: string;
  readonly conversation_id: string;
  readonly intake_batch_id: string;
  readonly order_id: string;
  readonly revision: number;
  readonly request_hash: string;
  readonly source: {
    readonly format: PilotSourceFormat;
    readonly artifact_ref: string;
    readonly sha256: string;
    readonly size_bytes: number;
    readonly provider_event_id: string;
  };
  readonly settings: {
    readonly copies: number;
    readonly duplex: boolean;
    readonly paper: PilotPaper;
    readonly color: 'black_white';
  };
  readonly settings_sha256: string;
  readonly printer_id: string;
}

/** Returned only to an authenticated staff/owner browser for the same shop. */
export interface PilotShopCodeDisplay {
  readonly schema: 'ai0.pilot_shop_code_display.v1';
  readonly shop_id: string;
  readonly code: string;
  readonly expires_at: string;
  readonly server_time: string;
}

/** Raw code exists only at OA ingress and Core validation; never in a job or log. */
export interface PilotCodeSubmission {
  readonly schema: 'ai0.pilot_code_submission.v1';
  readonly shop_id: string;
  readonly oa_id: string;
  readonly customer_id: string;
  readonly conversation_id: string;
  readonly intake_batch_id: string;
  readonly order_id: string;
  readonly revision: number;
  readonly provider_event_id: string;
  readonly code: string;
  readonly idempotency_key: string;
}

/** Durable provenance, created by Core in the same transaction as one print job. */
export interface PilotPrintAuthorization {
  readonly schema: 'ai0.pilot_print_authorization.v1';
  readonly shop_id: string;
  readonly oa_id: string;
  readonly customer_id: string;
  readonly intake_batch_id: string;
  readonly order_id: string;
  readonly revision: number;
  readonly request_hash: string;
  readonly source_sha256: string;
  readonly settings_sha256: string;
  readonly evidence_sha256: string;
  readonly printer_id: string;
  readonly code_window_id: string;
  readonly provider_event_id: string;
  readonly authorized_at: string;
  readonly job_id: string;
}

export type PilotReadiness = 'WAITING_FOR_FILE' | 'WAITING_FOR_SETTINGS' |
  'WAITING_FOR_CODE' | 'NEEDS_HUMAN' | 'AUTHORIZED' | 'SENDING' |
  'SIMULATED_DONE' | 'SENT_UNVERIFIED' | 'VERIFIED_DONE' | 'UNKNOWN';

/**
 * Core sets this from the locked shop settings in the server-issued claim.
 * An Agent/OA/browser caller cannot request or upgrade a mode. For
 * `controlled_test`, Core rechecks the persisted, unexpired shop/order/printer
 * grant (`core_print_controlled_test_scopes`: enabled, expires_at after the
 * database clock, exact shop/order/printer; configured_by is an active owner
 * in that shop) at claim, preflight, and mark-sending. Missing/mismatched
 * grants fail with CONTROLLED_TEST_SCOPE_REQUIRED; lookup failure is 503
 * CONTROLLED_TEST_SCOPE_UNAVAILABLE. The grant is internal authority and is
 * never serialized into the Agent DTO.
 */
export type PilotPrintMode = 'simulation' | 'controlled_test' | 'production';

/** Distinct pilot claim ticket; it has no legacy approval field. */
export interface PilotAgentJob {
  readonly job_id: string;
  readonly order_id: string;
  readonly revision: number;
  readonly request_hash: string;
  readonly printer_id: string;
  readonly lease_token: string;
  readonly lease_seconds: number;
  readonly mode: PilotPrintMode;
}

export interface PilotAgentClaimRequest {
  readonly printer_id: string;
  readonly idempotency_key: string;
}

export interface PilotAgentWorkEnvelope {
  readonly job: PilotAgentJob;
  readonly candidate: PilotWordPdfCandidate;
  readonly authorization: PilotPrintAuthorization;
}

/** HTTP claim response; source bytes are fetched separately, never base64 in JSON. */
export interface PilotAgentClaimResponse {
  readonly schema: 'ai0.pilot_agent_claim.v1';
  readonly work: PilotAgentWorkEnvelope | null;
}

export interface PilotAgentGateRequest {
  readonly expected_revision: number;
  readonly lease_token: string;
  readonly request_hash: string;
  readonly source_sha256: string;
  readonly settings_sha256: string;
  readonly evidence_sha256: string;
  readonly printer_id: string;
}

export interface PilotAgentGateReceipt {
  readonly schema: 'ai0.pilot_agent_gate_receipt.v1';
  readonly state: 'AUTHORIZED' | 'SENDING';
  readonly job_id: string;
  readonly order_id: string;
  readonly revision: number;
  readonly request_hash: string;
  readonly source_sha256: string;
  readonly settings_sha256: string;
  readonly evidence_sha256: string;
  readonly printer_id: string;
}

export type PilotAgentReportState = 'SIMULATED_DONE' | 'SENT_UNVERIFIED' | 'UNKNOWN';

/** Only these sanitized scalar fields are accepted by Core. */
export interface PilotAgentReportEvidence {
  readonly driver_called?: boolean;
  readonly spooler_ack?: boolean;
  readonly reason_code?: string;
}

export interface PilotAgentReport {
  readonly schema: 'ai0.pilot_agent_report.v1';
  readonly lease_token: string;
  readonly idempotency_key: string;
  readonly state: PilotAgentReportState;
  readonly evidence: Readonly<PilotAgentReportEvidence>;
}
