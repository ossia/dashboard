// Every remote branch of every tracked repo: unique commits vs the default
// branch, last commit date, and whether an open PR exists for it.
// "PR-less branch with unique commits" is the signal we care about.

import type { Config } from "../lib/config.ts";
import { daysAgo } from "../lib/config.ts";
import { aheadBehind, commitDate, lsRemote, pmap } from "../lib/git.ts";
import type { BranchInfo, PullRequest, Severity } from "../lib/types.ts";

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

    const infos = await pmap(branches, 6, async ([name, sha]): Promise<BranchInfo> => {
      const ab = await aheadBehind(repo.slug, defaultSha, sha);
      const date = await commitDate(repo.slug, sha);
      const prNumber = prByBranch.get(`${repo.slug}#${name}`) ?? null;
      const hasPR = prDataAvailable ? prNumber !== null : null;
      const idle = daysAgo(date);
      let severity: Severity = "ok";
      if ((ab?.ahead ?? 0) > 0 && hasPR === false) {
        severity =
          idle !== null && idle > th.prlessIdleWarnDays ? "warn" : "info";
      }
      return {
        repo: repo.slug,
        name,
        sha,
        lastCommitDate: date,
        ahead: ab?.ahead ?? null,
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
