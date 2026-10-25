import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ServiceWorker } from "@/components/service-worker";
import { SessionProvider } from "@/components/session-provider";
import "@samesight/next/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fieldbook",
  description: "A Samesight demo: offline inspections on Supabase and PowerSync.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased">
        <ServiceWorker>
          <SessionProvider>{children}</SessionProvider>
        </ServiceWorker>
      </body>
    </html>
  );
}
