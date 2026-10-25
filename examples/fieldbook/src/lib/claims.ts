export type AppRole = "ADMIN" | "INSPECTOR" | "VIEWER";

export type Claims = {
  userId: string;
  email: string | undefined;
  tenantId: string | undefined;
  appRole: AppRole | undefined;
};

// Reads the claims the custom access token hook added. This decodes without
// verifying: it only drives what the UI offers. Postgres RLS and the PowerSync
// service both verify the token before trusting any claim.
export function readClaims(accessToken: string): Claims {
  const payload = accessToken.split(".")[1] ?? "";
  const json = JSON.parse(
    atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")),
  ) as Record<string, unknown>;
  const role = json.app_role;
  return {
    userId: String(json.sub),
    email: typeof json.email === "string" ? json.email : undefined,
    tenantId: typeof json.tenant_id === "string" ? json.tenant_id : undefined,
    appRole: role === "ADMIN" || role === "INSPECTOR" || role === "VIEWER" ? role : undefined,
  };
}
