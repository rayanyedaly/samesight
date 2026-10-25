"use client";

import { useQuery, useStatus } from "@powersync/react";
import Link from "next/link";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { type Finding, type FindingChain, findingChains } from "@/lib/latest-only";
import type { InspectionRecord, MembershipRecord } from "@/lib/powersync/schema";
import { useSignedIn } from "./session-provider";
import { SEVERITY_LABEL, STATUS_LABEL, SeverityBadge, StatusBadge } from "./status-badge";

const STATUSES = ["DRAFT", "IN_PROGRESS", "PUBLISHED", "ARCHIVED"] as const;
// Publishing makes a report visible to viewers, so only admins do it (enforced by RLS).
const INSPECTOR_STATUSES: readonly string[] = ["DRAFT", "IN_PROGRESS"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;

export function InspectionDetail({ inspectionId }: { inspectionId: string }) {
  const { claims, db } = useSignedIn();
  const { hasSynced } = useStatus();
  const { data: inspections, isLoading } = useQuery<InspectionRecord & { id: string; siteName: string | null }>(
    `SELECT i.*, s.name AS siteName FROM Inspection i LEFT JOIN Site s ON s.id = i.siteId WHERE i.id = ?`,
    [inspectionId],
  );
  const { data: findings } = useQuery<Finding>(
    "SELECT * FROM Finding WHERE inspectionId = ? ORDER BY seq IS NULL, seq, id",
    [inspectionId],
  );
  const { data: inspectors } = useQuery<MembershipRecord & { id: string }>(
    "SELECT * FROM Membership WHERE role = 'INSPECTOR' AND userId IS NOT NULL ORDER BY displayName",
  );
  const chains = useMemo(() => findingChains(findings), [findings]);
  const inspection = inspections[0];

  if (!inspection) {
    return (
      <p role="status" className="text-sm text-muted">
        {isLoading || !hasSynced ? "Loading…" : "Inspection not found."}
      </p>
    );
  }

  const isAdmin = claims.appRole === "ADMIN";
  const isAssignedInspector = claims.appRole === "INSPECTOR" && inspection.assigneeId === claims.userId;
  const canEdit = isAdmin || (isAssignedInspector && INSPECTOR_STATUSES.includes(inspection.status ?? ""));
  const statuses = isAdmin ? STATUSES : STATUSES.filter((s) => INSPECTOR_STATUSES.includes(s));

  // updatedAt is set by the server.
  async function update(fields: Partial<InspectionRecord>) {
    const entries = Object.entries(fields);
    await db.execute(
      `UPDATE Inspection SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      [...entries.map(([, v]) => v), inspectionId],
    );
  }

  async function addFinding(body: string, severity: string, supersedesId: string | null) {
    await db.execute(
      `INSERT INTO Finding (id, tenantId, inspectionId, supersedesId, body, severity, createdBy)
       VALUES (uuid(), ?, ?, ?, ?, ?, ?)`,
      [inspection.tenantId, inspectionId, supersedesId, body, severity, claims.userId],
    );
  }

  return (
    <section>
      <Link href={`/sites/${inspection.siteId}`} className="text-sm text-muted hover:underline">
        <span aria-hidden="true">← </span>
        {inspection.siteName ?? "Site"}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{inspection.title}</h1>
        <StatusBadge status={inspection.status} />
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap gap-4">
          <label className="text-sm">
            <span className="mr-2 font-medium">Status</span>
            <select
              className="field inline-block w-auto"
              value={inspection.status ?? ""}
              onChange={(e) => void update({ status: e.target.value })}
            >
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {isAdmin && (
            <label className="text-sm">
              <span className="mr-2 font-medium">Inspector</span>
              <select
                className="field inline-block w-auto"
                value={inspection.assigneeId ?? ""}
                onChange={(e) => void update({ assigneeId: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {inspectors.map((m) => (
                  <option key={m.id} value={m.userId ?? ""}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {inspection.internalNotes && (
        <div className="mt-4 rounded-lg border border-line bg-subtle p-3 text-sm">
          <span className="font-medium">Internal notes. </span>
          {inspection.internalNotes}
        </div>
      )}

      <h2 className="mt-8 font-medium">Findings</h2>
      {chains.length === 0 && <p className="mt-2 text-sm text-muted">No findings yet.</p>}
      {chains.length > 0 && (
        <ul className="mt-2 space-y-3">
          {chains.map((chain) => (
            <FindingItem
              key={chain.latest.id}
              chain={chain}
              canAmend={isAssignedInspector}
              onAmend={(body, severity) => addFinding(body, severity, chain.latest.id)}
            />
          ))}
        </ul>
      )}

      {isAssignedInspector && (
        <FindingForm className="mt-6" submitLabel="Add finding" onSubmit={(b, s) => addFinding(b, s, null)} />
      )}
    </section>
  );
}

function FindingItem({
  chain,
  canAmend,
  onAmend,
}: {
  chain: FindingChain;
  canAmend: boolean;
  onAmend: (body: string, severity: string) => Promise<void>;
}) {
  const [amending, setAmending] = useState(false);
  const amendButton = useRef<HTMLButtonElement>(null);
  const { latest, earlier } = chain;

  // Focus returns to the Amend button, which is back once the form closes.
  function closeAmend() {
    setAmending(false);
    requestAnimationFrame(() => amendButton.current?.focus());
  }

  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <SeverityBadge severity={latest.severity} />
        {earlier.length > 0 && <span className="text-xs text-muted">Amended</span>}
        {latest.seq === null && <span className="text-xs text-warn">Not synced yet</span>}
        {canAmend && !amending && (
          <button
            ref={amendButton}
            type="button"
            className="btn ml-auto"
            aria-label={`Amend finding: ${latest.body ?? ""}`}
            onClick={() => setAmending(true)}
          >
            Amend
          </button>
        )}
      </div>
      <p className="mt-1">{latest.body}</p>
      {earlier.length > 0 && (
        <details className="mt-2 text-sm text-muted">
          <summary className="cursor-pointer">
            {earlier.length} earlier version{earlier.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-1">
            {earlier.map((f) => (
              <li key={f.id} className="line-through">
                {SEVERITY_LABEL[f.severity ?? ""] ?? f.severity}: {f.body}
              </li>
            ))}
          </ul>
        </details>
      )}
      {amending && (
        <FindingForm
          className="mt-3"
          initialBody={latest.body ?? ""}
          initialSeverity={latest.severity ?? "LOW"}
          submitLabel="Save amendment"
          autoFocus
          onCancel={closeAmend}
          onSubmit={async (body, severity) => {
            await onAmend(body, severity);
            closeAmend();
          }}
        />
      )}
    </li>
  );
}

function FindingForm({
  className,
  initialBody = "",
  initialSeverity = "LOW",
  submitLabel,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  className?: string;
  initialBody?: string;
  initialSeverity?: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (body: string, severity: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [severity, setSeverity] = useState(initialSeverity);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Findings cannot be deleted, so a double submit must not create two.
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(body.trim(), severity);
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className={`space-y-2 ${className ?? ""}`}>
      <label className="block">
        <span className="text-sm font-medium">Finding</span>
        <textarea
          className="field mt-1"
          rows={2}
          required
          // biome-ignore lint/a11y/noAutofocus: the amend form opens on request, so focus goes to its field
          autoFocus={autoFocus}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <label className="text-sm">
          <span className="mr-2 font-medium">Severity</span>
          <select className="field inline-block w-auto" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary ml-auto" disabled={submitting}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          Could not save: {error}
        </p>
      )}
    </form>
  );
}
