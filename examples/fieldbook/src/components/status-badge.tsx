export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  IN_PROGRESS: "In progress",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const SEVERITY_LABEL: Record<string, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

export function StatusBadge({ status }: { status: string | null }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-xs text-muted">
      {STATUS_LABEL[status ?? ""] ?? status}
    </span>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  HIGH: "text-danger",
  MEDIUM: "text-warn",
  LOW: "text-muted",
};

export function SeverityBadge({ severity }: { severity: string | null }) {
  return (
    <span className={`text-xs font-semibold ${SEVERITY_TONE[severity ?? ""] ?? ""}`}>
      {SEVERITY_LABEL[severity ?? ""] ?? severity}
    </span>
  );
}
