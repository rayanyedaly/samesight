# @samesight/next

The offline client side of a Supabase + PowerSync app on Next.js: a per-user encrypted local database, sign-in that works offline, and sync status a user can trust.

```bash
npm install @samesight/next @samesight/supabase @powersync/web @powersync/react @supabase/supabase-js
```

```tsx
"use client";
import { createEncryptedStore, RejectedWritesBanner, SamesightProvider, SyncStatusChip, useSamesight } from "@samesight/next";
import "@samesight/next/styles.css";
import { AppSchema } from "./samesight/app-schema";

// Once, at module level.
const store = createEncryptedStore({ schema: AppSchema, prefix: "myapp" });

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SamesightProvider supabase={supabase} authStorageKey="myapp-auth" store={store} powersyncUrl={POWERSYNC_URL}>
      <Shell>{children}</Shell>
    </SamesightProvider>
  );
}

// The provider shows the unlock and recovery screens itself; the rest is up to the app.
function Shell({ children }: { children: React.ReactNode }) {
  const { state, signIn } = useSamesight();
  if (state.status === "signed-out") return <SignInForm onSubmit={signIn} />;
  if (state.status !== "ready") return <p role="status">Loading</p>;
  return (
    <>
      <RejectedWritesBanner />
      <SyncStatusChip />
      {children}
    </>
  );
}
```

`authStorageKey` is the `storageKey` your Supabase client was created with, so the provider can read the stored session offline.

- **Encrypted at rest, per user.** One encrypted database (SQLite3MultipleCiphers) per user on the device, keyed with PBKDF2 (600,000 iterations) from the sign-in password. The key lives in memory only.
- **Offline unlock.** After a reload, or with an expired token and no network, the unlock screen reopens the local data with the password. Nothing goes to the network.
- **Idle lock that never deletes.** After 15 minutes without input the store closes and the key is forgotten; the data stays.
- **Safe sign-out.** `signOut()` counts the upload queue first and returns `pending` with the count instead of discarding unsynced writes; `force` confirms the loss.
- **Recovery that names the loss.** A store that will not open is never deleted silently: the recovery screen says what discarding it costs.
- **Honest status.** `SyncStatusChip` only says "synced" when connected, idle and the queue is empty, and shows how long writes have existed only on this device. `RejectedWritesBanner` shows writes the server refused, with their content.
- The components' styles are in `styles.css` and theme through `--ss-*` CSS variables; their text can be replaced through `copy` props.

`useSamesight()` gives the state (`loading`, `signed-out`, `locked`, `recover`, `ready`) and the actions (`signIn`, `unlock`, `lock`, `signOut`, `retry`, `discardLocalData`).

[Fieldbook](https://github.com/rayanyedaly/samesight/tree/main/examples/fieldbook) is a complete app built on it, including the service worker setup and Turbopack's prebuilt-worker option (`createEncryptedStore({ worker: "/@powersync/worker.js" })`).

One tab at a time: the store does not coordinate an unlock across tabs yet.

MIT
