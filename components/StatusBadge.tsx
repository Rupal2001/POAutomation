const labels: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  issued: "Sent to supplier",
  partially_received: "Part received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
  generated: "Plan ready",
  uploaded: "Data uploaded",
  archived: "Archived",
};

const tones: Record<string, string> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "brand",
  issued: "info",
  partially_received: "purple",
  received: "positive",
  closed: "neutral",
  cancelled: "critical",
  generated: "positive",
  uploaded: "warning",
  archived: "neutral",
};

export default function StatusBadge({ status }: { status: string }) {
  const label = labels[status] ?? status.replaceAll("_", " ");
  return <span className={`status-badge status-${tones[status] ?? "neutral"}`}><span aria-hidden="true"/>{label}</span>;
}
