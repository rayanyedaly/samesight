"use client";

import { useQuery, useStatus } from "@powersync/react";
import Link from "next/link";

type SiteRow = { id: string; name: string | null; address: string | null; inspections: number };

export function SiteList() {
  const { hasSynced } = useStatus();
  const { data: sites, isLoading } = useQuery<SiteRow>(
    `SELECT s.id, s.name, s.address,
            (SELECT count(*) FROM Inspection i WHERE i.siteId = s.id) AS inspections
       FROM Site s
      ORDER BY s.name`,
  );

  return (
    <section>
      <h1 className="text-xl font-semibold">Sites</h1>
      {sites.length === 0 && (
        <p role="status" className="mt-4 text-sm text-muted">
          {isLoading || !hasSynced ? "Loading…" : "No sites yet."}
        </p>
      )}
      {sites.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
          {sites.map((site) => (
            <li key={site.id}>
              <Link
                href={`/sites/${site.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-subtle"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{site.name}</span>
                  <span className="block text-sm text-muted">{site.address}</span>
                </span>
                <span className="shrink-0 text-sm text-muted">
                  {site.inspections} inspection{site.inspections === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
