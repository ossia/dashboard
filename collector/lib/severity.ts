import type { AttentionItem, Severity, Snapshot } from "./types.ts";
import type { Config } from "./config.ts";

export const rank: Record<Severity, number> = { ok: 0, info: 1, warn: 2, crit: 3 };

export function worst(...sevs: Severity[]): Severity {
  return sevs.reduce((a, b) => (rank[b] > rank[a] ? b : a), "ok");
}

/** Flatten every graded item into the attention feed, applying ignores. */
export function buildAttention(s: Snapshot, cfg: Config): AttentionItem[] {
  const items: AttentionItem[] = [];
  const push = (i: AttentionItem) => {
    if (rank[i.severity] < rank.warn) return;
    if (cfg.ignore.some((ig) => i.id.includes(ig.match))) return;
    items.push(i);
  };

  for (const m of s.submodules)
    push({
      id: `submodule:${m.parentRepo}:${m.path}`,
      category: "submodule",
      repo: m.parentRepo,
      subject: m.path,
      message:
        m.notes.join("; ") ||
        `pin is ${m.behindCount ?? "?"} commits / ${fmtDays(m.behindDays)} behind ${m.targetRepo ?? m.url}`,
      url: m.targetRepo ? `https://github.com/${m.targetRepo}` : null,
      severity: m.severity,
    });

  for (const d of s.dependencies)
    push({
      id: `dependency:${d.repo}:${d.source}:${d.name}`,
      category: "dependency",
      repo: d.repo,
      subject: `${d.name} (${d.source})`,
      message: d.notes.join("; "),
      url: !d.upstream
        ? null
        : d.upstream.startsWith("gitlab:")
          ? `https://gitlab.com/${d.upstream.slice(7)}`
          : `https://github.com/${d.upstream}`,
      severity: d.severity,
    });

  for (const p of s.prs)
    push({
      id: `pr:${p.repo}:${p.number}`,
      category: "pr",
      repo: p.repo,
      subject: `#${p.number} ${p.title}`,
      message: `idle ${Math.round(p.idleDays)}d, ${p.behindBase ?? "?"} commits behind ${p.baseRef}`,
      url: p.url,
      severity: p.severity,
    });

  for (const b of s.branches)
    push({
      id: `branch:${b.repo}:${b.name}`,
      category: "branch",
      repo: b.repo,
      subject: b.name,
      message:
        `${b.aheadReal ?? b.ahead ?? "?"} unmerged commits` +
        (b.landedEquivalent ? ` (${b.landedEquivalent} already cherry-picked)` : "") +
        `, no PR, last commit ${b.lastCommitDate?.slice(0, 10) ?? "?"}`,
      url: `https://github.com/${b.repo}/tree/${b.name}`,
      severity: b.severity,
    });

  for (const a of s.actions)
    push({
      id: `action:*:${a.action}`,
      category: "action",
      repo: a.refs[0]?.repo ?? "*",
      subject: a.action,
      message:
        a.outdatedRefs.length > 0
          ? `used at ${[...new Set(a.outdatedRefs)].join(", ")}, latest is ${a.latestTag}`
          : `mutable ref ${a.mutableRefs.join(", ")} in use`,
      url: `https://github.com/${a.action.split("/").slice(0, 2).join("/")}`,
      severity: a.severity,
    });

  for (const e of s.environments)
    push({
      id: `environment:${e.repo}:${e.name}@${e.location}`,
      category: "environment",
      repo: e.repo,
      subject: `${e.name} (${e.current})`,
      message:
        e.status === "eol"
          ? `EOL since ${e.eolDate}`
          : e.status === "eol-soon"
            ? `EOL on ${e.eolDate}`
            : e.missingFromMatrix.length
              ? `newer releases not in CI matrix: ${e.missingFromMatrix.join(", ")}`
              : `latest is ${e.latest}`,
      url: null,
      severity: e.severity,
    });

  for (const r of s.packaging)
    push({
      id: `packaging:repology:${r.project}`,
      category: "packaging",
      repo: r.project,
      subject: r.project,
      message: `${r.outdated}/${r.total} downstream repos ship an outdated version (newest: ${r.newestVersion})`,
      url: `https://repology.org/project/${r.project}/versions`,
      severity: r.severity,
    });

  items.sort((a, b) => rank[b.severity] - rank[a.severity] || a.id.localeCompare(b.id));
  return items;
}

/** Per-repo warn/crit/info counts per category, for the index health strip. */
export function rollupRepoCounts(s: Snapshot): void {
  const find = (slug: string) => s.repos.find((r) => r.slug === slug);
  const bump = (slug: string, cat: string, sev: Severity) => {
    if (rank[sev] < rank.info) return;
    const r = find(slug);
    if (!r) return;
    const c = (r.counts[cat] ??= { warn: 0, crit: 0, info: 0 });
    if (sev === "info") c.info++;
    else if (sev === "warn") c.warn++;
    else c.crit++;
  };
  for (const m of s.submodules) bump(m.parentRepo, "submodules", m.severity);
  for (const d of s.dependencies) bump(d.repo, "dependencies", d.severity);
  for (const p of s.prs) bump(p.repo, "prs", p.severity);
  for (const b of s.branches) bump(b.repo, "branches", b.severity);
  for (const a of s.actions)
    for (const repo of new Set(a.refs.map((r) => r.repo))) bump(repo, "actions", a.severity);
  for (const e of s.environments) bump(e.repo, "environments", e.severity);
}

export function fmtDays(d: number | null): string {
  if (d === null) return "?";
  if (d < 1.5) return "1 day";
  if (d < 60) return `${Math.round(d)} days`;
  if (d < 700) return `${Math.round(d / 30.4)} months`;
  return `${(d / 365).toFixed(1)} years`;
}
