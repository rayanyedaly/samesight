/**
 * Whether a failed write can never succeed on retry. Retried: network failures
 * (status 0), expired tokens (401), timeouts and rate limits, and server errors (5xx).
 * Everything else in 4xx is permanent: RLS (403/42501), constraints (409/23xxx), bad
 * data (22xxx), and schema drift such as an unknown column (PGRST204).
 */
export function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}
