"use client";

import { AppShell } from "@/components/app-shell";
import { SiteList } from "@/components/site-list";

export default function HomePage() {
  return (
    <AppShell>
      <SiteList />
    </AppShell>
  );
}
