/**
 * Sorting failed uploads: retry, re-authenticate, hold, or reject.
 *
 * The distinction is between "the server will never accept this" and "the server did
 * not accept this right now", and getting it wrong in the lenient direction destroys
 * data: a write sorted as permanent is taken out of the upload queue. So only failures
 * that cannot succeed on retry are rejected; anything temporary or unclear stays queued.
 */

/** What the connector does with a failed `apply_batch` call. */
export type UploadOutcome =
  /** Temporary: throw, PowerSync retries later and the write stays queued. */
  | "retry"
  /** The session expired: refresh it, then throw so PowerSync retries. */
  | "reauth"
  /** Will not succeed as is, but discarding is worse: keep it queued and tell a person. */
  | "stuck"
  /** Will never succeed: record it as a rejected write, then take it out of the queue. */
  | "reject";

/** The parts of a supabase-js error response this needs. `status` is 0 for a network failure. */
export interface UploadFailure {
  status: number;
  code?: string | null;
  /** The error message, which tells a server misconfiguration apart from RLS within 42501. */
  message?: string | null;
}

// Postgres errors that clear up on retry: statement timeout, serialization failure,
// deadlock, connection exceptions (08), and insufficient resources (53).
const TEMPORARY_CODES = /^(57014|40001|40P01|08...|53...)$/;
// Postgres errors that never clear up: data exceptions (22), integrity violations (23),
// insufficient privilege (42501, which is RLS), and refusals raised by apply_batch (P0001).
const PERMANENT_CODES = /^(22...|23...|42501|P0001)$/;
// PostgREST's own JWT errors (missing, invalid or expired token), and 28000, which
// apply_batch raises for a token without a tenant: a refreshed token may carry one.
const AUTH_CODES = /^(PGRST30[0-3]|28000)$/;
// 42501 that is not about the row: the caller may not run apply_batch, or reach its schema
// or a sequence. A server that is not set up, not a judgement on the write.
const MISCONFIGURED = /permission denied for (function|procedure|schema|sequence)\b/i;
// The server, not the write, is at fault: SS001 (apply_batch does not know this table or
// op, so the client is newer than the server), syntax or undefined-object errors (42,
// except 42501) from SQL that drifted from the schema, and a read-only database (25006).
const SERVER_FAULT_CODES = /^(SS001|25006|42(?!501)...)$/;

/**
 * Is this HTTP status a permanent refusal, or something worth retrying? Ported as is:
 * 408, 425 and 429 mean "later", 413 is held rather than dropped, 5xx is temporary.
 */
export function isPermanentRejection(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return false;
  if (status === 413) return false;
  return status >= 400 && status < 500;
}

export function classifyUploadError({ status, code, message }: UploadFailure): UploadOutcome {
  const c = code ?? "";
  if (status === 401 || AUTH_CODES.test(c)) return "reauth";
  if (status === 413) return "stuck";
  if (TEMPORARY_CODES.test(c)) return "retry";
  if (SERVER_FAULT_CODES.test(c)) return "stuck";
  if (c === "42501" && MISCONFIGURED.test(message ?? "")) return "stuck";
  // Only Postgres's own judgements on the data are final: everything else that comes back
  // as a 4xx (PostgREST's PGRST codes for a schema or request it cannot serve, a missing
  // apply_batch, a proxy, a gateway, a firewall) is not the write's fault, and dropping
  // the queue for it would discard every write. Hold it and tell someone instead.
  if (PERMANENT_CODES.test(c)) return "reject";
  if (isPermanentRejection(status)) return "stuck";
  return "retry";
}
