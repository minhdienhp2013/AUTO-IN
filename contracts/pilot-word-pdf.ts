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
  'SIMULATED_DONE' | 'SENT_UNVERIFIED' | 'UNKNOWN';
