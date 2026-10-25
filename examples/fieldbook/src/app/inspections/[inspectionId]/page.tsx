"use client";

import { useParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { InspectionDetail } from "@/components/inspection-detail";

export default function InspectionPage() {
  const { inspectionId } = useParams<{ inspectionId: string }>();
  return (
    <AppShell>
      <InspectionDetail inspectionId={inspectionId} />
    </AppShell>
  );
}
