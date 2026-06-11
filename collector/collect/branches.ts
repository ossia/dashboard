// Every remote branch of every tracked repo: unique commits vs the default
// branch, last commit date, and whether an open PR exists for it.
//
// "Unique" is cherry-pick aware: a branch commit whose patch already landed
// on the default branch via cherry-pick / rebase / squash is noise, not
// unmerged work. True patch-id comparison needs file contents (which the
// commit-graph-only clones don't have), but cherry-pick and rebase preserve
// the author email + author timestamp, and usually the summary line. So a
// branch commit counts as already-landed when the default branch contains a
// commit with the same (author, author-time) or the same (author, summary).
// Branches whose every unique commit matched are reported as prunable
// instead of "PR-less with unmerged commits".

import type { Config } from "../lib/config.ts";
import { daysAgo } from "../lib/config.ts";
import { aheadBehind, commitDate, logCommits, lsRemote, pmap } from "../lib/git.ts";
import type { BranchInfo, PullRequest, Severity } from "../lib/types.ts";

const INDEX_MAX = 200_000; // commits of the default branch indexed per repo
const BRANCH_MAX = 2_000; // unique commits examined per branch

interface LandedIndex {
  byAuthorTime: Set<string>;
  byAuthorSummary: Set<string>;
}

async function buildLandedIndex(
  slug: string,
  defaultSha: string,
): Promise<LandedIndex | null> {
  const commits = await logCommits(slug, defaultSha, {
    noMerges: true,
    maxCount: INDEX_MAX,
  });
  if (!commits) return null;
  const idx: LandedIndex = { byAuthorTime: new Set(), byAuthorSummary: new Set() };
  for (const c of commits) {
    idx.byAuthorTime.add(`${c.authorEmail}@${c.authorTime}`);
    // summary matching is only trustworthy for non-generic messages
    if (c.summary.length >= 12)
      idx.byAuthorSummary.add(`${c.authorEmail}|${c.summary}`);
  }
  return idx;
}

export async function collectBranches(
  cfg: Config,
  prs: PullRequest[],
  prDataAvailable: boolean,
): Promise<BranchInfo[]> {
  const th = cfg.thresholds.branch;
  const prByBranch = new Map<string, number>();
  for (const p of prs) prByBranch.set(`${p.repo}#${p.headRef}`, p.number);

  const out: BranchInfo[] = [];
  for (const repo of cfg.repos) {
    const refs = await lsRemote(repo.slug);
    if (!refs?.headBranch) continue;
    const defaultSha = refs.branches.get(refs.headBranch);
    if (!defaultSha) continue;
    const branches = [...refs.branches].filter(([name]) => name !== refs.headBranch);
    const landed = await buildLandedIndex(repo.slug, defaultSha);

    const infos = await pmap(branches, 6, async ([name, sha]): Promise<BranchInfo> => {
      const ab = await aheadBehind(repo.slug, defaultSha, sha);
      const date = await commitDate(repo.slug, sha);
      const prNumber = prByBranch.get(`${repo.slug}#${name}`) ?? null;
      const hasPR = prDataAvailable ? prNumber !== null : null;
      const idle = daysAgo(date);

      let aheadReal: number | null = ab?.ahead ?? null;
      let landedEquivalent: number | null = null;
      if (landed && (ab?.ahead ?? 0) > 0) {
        const unique = await logCommits(repo.slug, `${defaultSha}..${sha}`, {
          noMerges: true,
          maxCount: BRANCH_MAX,
        });
        if (unique) {
          const matched = unique.filter(
            (c) =>
              landed.byAuthorTime.has(`${c.authorEmail}@${c.authorTime}`) ||
              (c.summary.length >= 12 &&
                landed.byAuthorSummary.has(`${c.authorEmail}|${c.summary}`)),
          ).length;
          landedEquivalent = matched;
          aheadReal = unique.length - matched;
        }
      } else if ((ab?.ahead ?? 0) === 0) {
        aheadReal = ab ? 0 : null;
      }

      let severity: Severity = "ok";
      if ((aheadReal ?? 0) > 0 && hasPR === false) {
        severity = idle !== null && idle > th.prlessIdleWarnDays ? "warn" : "info";
      }
      return {
        repo: repo.slug,
        name,
        sha,
        lastCommitDate: date,
        ahead: ab?.ahead ?? null,
        aheadReal,
        landedEquivalent,
        behind: ab?.behind ?? null,
        hasPR,
        prNumber,
        severity,
      };
    });
    out.push(...infos);
  }
  return out;
}
