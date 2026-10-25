"use client";

import { type FormEvent, useState } from "react";
import { useSession } from "./session-provider";

export function SignIn() {
  const { signIn } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(await signIn(String(form.get("email")), String(form.get("password"))));
    setPending(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold">Fieldbook</h1>
      <p className="mt-1 text-sm text-muted">Inspections that keep working when the signal drops.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input name="email" type="email" required autoComplete="username" className="field mt-1" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input name="password" type="password" required autoComplete="current-password" className="field mt-1" />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending} className="btn-primary w-full">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-6 text-xs text-muted">
        Seeded accounts: admin@, inspector@ or viewer@ northwind.test or harbor.test, password
        &ldquo;fieldbook-demo&rdquo;.
      </p>
    </main>
  );
}
