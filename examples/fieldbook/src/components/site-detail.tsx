"use client";

import { useQuery, useStatus } from "@powersync/react";
import Link from "next/link";
import type { InspectionRecord, SiteRecord } from "@/lib/powersync/schema";
import { StatusBadge } from "./status-badge";

type InspectionRow = Pick<InspectionRecord, "id" | "title" | "status"> & { assignee: string | null };

export function SiteDetail({ siteId }: { siteId: string }) {
  const { hasSynced } = useStatus();
  const { data: sites, isLoading } = useQuery<SiteRecord>("SELECT * FROM Site WHERE id = ?", [siteId]);
  const { data: inspections } = useQuery<InspectionRow>(
    `SELECT i.id, i.title, i.status, m.displayName AS assignee
       FROM Inspection i
       LEFT JOIN Membership m ON m.userId = i.assigneeId
      WHERE i.siteId = ?
      ORDER BY i.createdAt DESC, i.title`,
    [siteId],
  );
  const site = sites[0];

  if (!site) {
    return (
      <p role="status" className="text-sm text-muted">
        {isLoading || !hasSynced ? "Loading…" : "Site not found."}
      </p>
    );
  }

  return (
    <section>
      <Link href="/" className="text-sm text-muted hover:underline">
        <span aria-hidden="true">← </span>Sites
      </Link>
      <h1 className="mt-2 text-xl font-semibold">{site.name}</h1>
      <p className="text-sm text-muted">{site.address}</p>
      <h2 className="mt-6 font-medium">Inspections</h2>
      {inspections.length === 0 && <p className="mt-2 text-sm text-muted">None you can see.</p>}
      {inspections.length > 0 && (
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
        {inspections.map((inspection) => (
          <li key={inspection.id}>
            <Link
              href={`/inspections/${inspection.id}`}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-subtle"
            >
              <span className="font-medium">{inspection.title}</span>
              <span className="flex shrink-0 items-center gap-3 text-sm text-muted">
                {inspection.assignee && <span>{inspection.assignee}</span>}
                <StatusBadge status={inspection.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
