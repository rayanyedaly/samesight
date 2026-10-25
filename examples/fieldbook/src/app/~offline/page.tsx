export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold">You&rsquo;re offline</h1>
      <p className="mt-2 text-sm text-muted">
        This page has not been opened on this device yet, so it is not available offline. Pages you have opened before
        still work, and your changes are saved on this device until you&rsquo;re back online.
      </p>
      <a href="/" className="btn mt-6 self-start">
        Go to sites
      </a>
    </main>
  );
}
