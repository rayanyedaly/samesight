// Public configuration, inlined by Next.js at build time. scripts/stack-up.sh writes
// these to .env.local for the local stack.
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set. Run \`pnpm --filter fieldbook stack:up\`.`);
  return value;
}

export const env = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabasePublishableKey: required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  powersyncUrl: required("NEXT_PUBLIC_POWERSYNC_URL", process.env.NEXT_PUBLIC_POWERSYNC_URL),
};
