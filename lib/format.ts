const numeric = (value: number | string | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Exact INR for tables and commercial documents; whole rupees stay uncluttered. */
export function formatINR(value: number | string, compact = false) {
  const amount = numeric(value);
  if (compact) return formatCompactINR(amount);
  const hasPaise = Math.abs(amount % 1) > 0.0001;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Predictable Indian business notation instead of browser-specific compact labels. */
export function formatCompactINR(value: number | string) {
  const amount = numeric(value);
  const absolute = Math.abs(amount);
  const sign = amount < 0 ? "−" : "";
  if (absolute >= 10_000_000) return `${sign}₹${trimDecimal(absolute / 10_000_000)}Cr`;
  if (absolute >= 100_000) return `${sign}₹${trimDecimal(absolute / 100_000)}L`;
  if (absolute >= 1_000) return `${sign}₹${trimDecimal(absolute / 1_000)}K`;
  return `${sign}₹${formatIndianNumber(absolute)}`;
}

export function formatIndianNumber(value: number | string, maximumFractionDigits = 0) {
  return numeric(value).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

export function formatPct(value: number | string | null | undefined, fallback = "Not enough history") {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? fallback
    : `${numeric(value).toFixed(1)}%`;
}

export function formatDate(value: string | Date | null | undefined, fallback = "Not set") {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined, fallback = "Not yet") {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export function formatBias(value: number | string | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Not enough history";
  const bias = numeric(value);
  if (Math.abs(bias) < 2) return "Balanced";
  return `${Math.abs(bias).toFixed(1)}% ${bias > 0 ? "high" : "low"}`;
}

function trimDecimal(value: number) {
  return value >= 100 ? Math.round(value).toLocaleString("en-IN") : value.toFixed(1).replace(/\.0$/, "");
}
