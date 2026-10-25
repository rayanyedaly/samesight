"use client";

import { useParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SiteDetail } from "@/components/site-detail";

export default function SitePage() {
  const { siteId } = useParams<{ siteId: string }>();
  return (
    <AppShell>
      <SiteDetail siteId={siteId} />
    </AppShell>
  );
}
