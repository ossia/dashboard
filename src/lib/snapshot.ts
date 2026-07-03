import type { Snapshot, Severity, UpdatePlan } from "../../collector/lib/types.ts";
import raw from "../../data/snapshot.json";
import planRaw from "../../data/update-plan.json";

export const snapshot = raw as unknown as Snapshot;
export const updatePlan = planRaw as unknown as UpdatePlan;
export type { Severity };

export const sevRank: Record<Severity, number> = { ok: 0, info: 1, warn: 2, crit: 3 };

export function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = (Date.parse(snapshot.generatedAt) - Date.parse(iso)) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "1d";
  if (d < 60) return `${Math.round(d)}d`;
  if (d < 700) return `${Math.round(d / 30.4)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export function fmtBehind(days: number | null): string {
  if (days === null) return "—";
  if (days < 1) return "current";
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 700) return `${Math.round(days / 30.4)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** numeric sort key attribute value for the client-side sorter */
export function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

export function repoShort(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

export const staleSections = Object.entries(snapshot.sections)
  .filter(([, m]) => m.source !== "live")
  .map(([name, m]) => ({ name, ...m }));
