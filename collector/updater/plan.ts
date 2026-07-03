// Turn the dependency inventory into concrete, reviewable update proposals.
// This computes WHAT would change (repo, file, current ref -> target ref); it
// opens nothing. Applying the plan as PRs is the separate, opt-in
// scripts/apply-updates.ts step.
//
// A dependency is proposed for a bump when:
//   - updates are enabled and its source is an editable single-line pin,
//   - its upstream is one of ours (or ourUpstreams is empty), and
//   - it is genuinely behind:
//       version pin -> a newer latest tag exists         (bump to the tag)
//       sha pin     -> upstream default branch has moved  (bump to HEAD sha)

import type { Config } from "../lib/config.ts";
import type { Dependency, UpdatePlan, UpdateProposal } from "../lib/types.ts";

function compareUrl(upstream: string, base: string, head: string): string | null {
  if (!upstream || upstream.startsWith("gitlab:")) return null;
  return `https://github.com/${upstream}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
}

function proposalFor(cfg: Config, d: Dependency): UpdateProposal | null {
  if (!d.upstream) return null;
  if (!cfg.updates.sources.includes(d.source)) return null;
  if (cfg.updates.ourUpstreams.length > 0 && !cfg.updates.ourUpstreams.includes(d.upstream))
    return null;
  if (d.tracksBranch) return null; // moving-branch pins are already "latest"

  let kind: "version" | "sha";
  let currentRef: string;
  let targetRef: string;
  let targetDisplay: string;

  if (d.pinnedVersion && d.latestTag && d.outdated && d.pinnedVersion !== d.latestTag) {
    kind = "version";
    currentRef = d.pinnedRefName ?? d.pinnedVersion;
    targetRef = d.latestTag;
    targetDisplay = d.latestTag;
  } else if (
    d.pinnedSha &&
    d.upstreamHeadSha &&
    (d.behindMainCommits ?? 0) > 0 &&
    !d.upstreamHeadSha.startsWith(d.pinnedSha)
  ) {
    kind = "sha";
    currentRef = d.pinnedSha;
    targetRef = d.upstreamHeadSha;
    targetDisplay = `${d.upstreamHeadSha.slice(0, 12)} (${d.defaultBranch ?? "HEAD"})`;
  } else {
    return null;
  }

  const shortRepo = d.repo.split("/")[1] ?? d.repo;
  return {
    repo: d.repo,
    source: d.source,
    name: d.name,
    file: d.location,
    upstream: d.upstream,
    kind,
    currentRef,
    targetRef,
    targetDisplay,
    behindCommits: d.behindMainCommits,
    behindDays: d.behindMainDays,
    branch: `${cfg.updates.branchPrefix}${shortRepo}/${d.name}`.toLowerCase().replace(/[^a-z0-9/_.-]/g, "-"),
    title: `chore(deps): bump ${d.name} to ${targetDisplay}`,
    compareUrl: compareUrl(d.upstream, currentRef, targetRef),
  };
}

export function buildUpdatePlan(cfg: Config, deps: Dependency[], generatedAt: string): UpdatePlan {
  const proposals: UpdateProposal[] = [];
  if (cfg.updates.enabled) {
    for (const d of deps) {
      const p = proposalFor(cfg, d);
      if (p) proposals.push(p);
    }
    proposals.sort(
      (a, b) => (b.behindCommits ?? 0) - (a.behindCommits ?? 0) || a.repo.localeCompare(b.repo),
    );
  }
  return { generatedAt, enabled: cfg.updates.enabled, proposals };
}
