// deps.yaml-driven upstream tracking. The registry (score/3rdparty/deps.yaml,
// already consumed by Renovate) lists every vendored dep with its true
// upstream and the version/SHA we vendored. For each entry:
//   - latest upstream tag vs pinned version  -> outdated?
//   - upstream HEAD date vs pin              -> "dead upstream came back to
//     life" when activity falls inside the revival window.

import { parse } from "yaml";
import type { Config } from "../lib/config.ts";
import { daysAgo } from "../lib/config.ts";
import {
  commitDate,
  compareKeys,
  ensureSha,
  isRepoSlug,
  latestTag,
  lsRemote,
  pmap,
  readFileAtHead,
  versionKey,
} from "../lib/git.ts";
import type { UpstreamWatch } from "../lib/types.ts";
import { fmtDays, worst } from "../lib/severity.ts";

interface DepsEntry {
  name: string;
  upstream?: string;
  upstream_version?: string | number;
  upstream_sha?: string;
}

export async function collectUpstreams(cfg: Config): Promise<UpstreamWatch[]> {
  const out: UpstreamWatch[] = [];
  for (const repo of cfg.repos) {
    if (!repo.depsRegistry) continue;
    const text = await readFileAtHead(repo.slug, repo.depsRegistry);
    if (!text) {
      console.warn(`deps registry ${repo.slug}:${repo.depsRegistry} not readable`);
      continue;
    }
    const doc = parse(text) as { deps?: DepsEntry[] };
    const entries = (doc.deps ?? []).filter((d) => d && d.name);
    const watches = await pmap(entries, 8, (e) => gradeEntry(cfg, repo.slug, e));
    out.push(...watches.filter((w): w is UpstreamWatch => w !== null));
  }
  return out;
}

async function gradeEntry(
  cfg: Config,
  registry: string,
  e: DepsEntry,
): Promise<UpstreamWatch | null> {
  if (!e.upstream || !isRepoSlug(e.upstream)) {
    // inert manifest entry: vendored, nothing tracked (the registry uses
    // free-text like "(Munts Technologies)" for upstreams that aren't repos)
    return {
      name: e.name,
      registry,
      upstream: "",
      kind: "vendored",
      pinnedVersion: null,
      pinnedSha: null,
      latestTag: null,
      latestTagDate: null,
      upstreamHeadSha: null,
      upstreamHeadDate: null,
      outdated: false,
      revived: false,
      severity: "ok",
      notes: [e.upstream ? `vendored: ${e.upstream}` : "vendored, no upstream tracked"],
    };
  }
  const w: UpstreamWatch = {
    name: e.name,
    registry,
    upstream: e.upstream,
    kind: e.upstream_sha ? "fork" : "upstream",
    pinnedVersion: e.upstream_version != null ? String(e.upstream_version) : null,
    pinnedSha: e.upstream_sha ?? null,
    latestTag: null,
    latestTagDate: null,
    upstreamHeadSha: null,
    upstreamHeadDate: null,
    outdated: false,
    revived: false,
    severity: "ok",
    notes: [],
  };
  const refs = await lsRemote(e.upstream);
  if (!refs) {
    w.notes.push("upstream unreachable");
    w.severity = "info";
    return w;
  }
  w.upstreamHeadSha = refs.headSha;
  if (refs.headSha) w.upstreamHeadDate = await commitDate(e.upstream, refs.headSha);

  // tag comparison
  const latest = latestTag(refs);
  if (latest) {
    w.latestTag = latest.tag;
    w.latestTagDate = await commitDate(e.upstream, latest.sha);
  }
  if (w.pinnedVersion && w.latestTag) {
    const pk = versionKey(w.pinnedVersion);
    const lk = versionKey(w.latestTag);
    if (pk && lk && compareKeys(lk, pk) > 0) {
      w.outdated = true;
      w.severity = worst(w.severity, lk[0]! > pk[0]! ? "warn" : "info");
      w.notes.push(`pinned ${w.pinnedVersion}, upstream released ${w.latestTag}`);
    }
  }

  // SHA-tracked entries: how far has upstream HEAD moved?
  if (w.pinnedSha && refs.headSha) {
    const full = refs.headSha.startsWith(w.pinnedSha) ? refs.headSha : null;
    const pinIsHead = full !== null;
    if (!pinIsHead) {
      const pinnedDate = (await ensureSha(e.upstream, w.pinnedSha))
        ? await commitDate(e.upstream, w.pinnedSha)
        : null;
      const headAge = daysAgo(w.upstreamHeadDate);
      const pinAge = daysAgo(pinnedDate);
      if (headAge !== null && pinAge !== null && pinAge > headAge) {
        const moved = pinAge - headAge;
        w.outdated = true;
        w.notes.push(`upstream HEAD moved ${fmtDays(moved)} past our pin`);
        // fork revival: upstream was dormant when pinned, now active again
        if (headAge < cfg.thresholds.upstream.revivedWindowDays) {
          w.revived = true;
          w.severity = worst(w.severity, "warn");
          w.notes.push(
            `upstream active again (last commit ${w.upstreamHeadDate?.slice(0, 10)})`,
          );
        } else {
          w.severity = worst(w.severity, "info");
        }
      }
    }
  } else if (
    w.kind === "upstream" &&
    !w.pinnedVersion &&
    w.upstreamHeadDate &&
    daysAgo(w.upstreamHeadDate)! < cfg.thresholds.upstream.revivedWindowDays
  ) {
    w.notes.push("upstream active; entry has no pinned version to compare");
  }
  return w;
}
