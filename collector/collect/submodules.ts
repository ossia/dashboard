// For every tracked repo: parse .gitmodules + `git ls-tree` of HEAD to get
// each submodule's pinned SHA, then grade the pin against the *target*
// repository: is it reachable from the target's default branch, how many
// commits / days behind its HEAD is it?

import type { Config } from "../lib/config.ts";
import { daysAgo } from "../lib/config.ts";
import {
  branchesContaining,
  commitDate,
  ensureSha,
  lsRemote,
  pmap,
  revListCount,
} from "../lib/git.ts";
import { workTree, gitInTree } from "../lib/worktree.ts";
import type { Severity, SubmodulePin } from "../lib/types.ts";
import { worst } from "../lib/severity.ts";
import { fmtDays } from "../lib/severity.ts";

function parseGitmodules(text: string): { path: string; url: string }[] {
  const out: { path: string; url: string }[] = [];
  let cur: { path?: string; url?: string } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[submodule")) {
      if (cur?.path && cur.url) out.push({ path: cur.path, url: cur.url });
      cur = {};
    } else if (cur) {
      const m = line.match(/^(path|url)\s*=\s*(.+)$/);
      if (m) cur[m[1] as "path" | "url"] = m[2]!.trim();
    }
  }
  if (cur?.path && cur.url) out.push({ path: cur.path, url: cur.url });
  return out;
}

/** github/gitlab https or ssh URL -> slug usable by the git layer. */
export function urlToSlug(url: string): string | null {
  let m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = url.match(/gitlab\.com[:/]+(.+?)(?:\.git)?\/?$/);
  if (m) return `gitlab:${m[1]}`;
  return null;
}

export async function collectSubmodules(cfg: Config): Promise<SubmodulePin[]> {
  const th = cfg.thresholds.submodule;
  const pins: SubmodulePin[] = [];

  for (const repo of cfg.repos) {
    const tree = await workTree(repo.slug);
    if (!tree) continue;
    let gitmodules: string;
    try {
      gitmodules = await gitInTree(tree, ["show", "HEAD:.gitmodules"]);
    } catch {
      continue; // no submodules
    }
    const mods = parseGitmodules(gitmodules);
    if (mods.length === 0) continue;

    // pinned SHAs of all gitlinks in one ls-tree
    const lsTree = await gitInTree(tree, ["ls-tree", "-r", "HEAD"]);
    const shaByPath = new Map<string, string>();
    for (const line of lsTree.split("\n")) {
      const m = line.match(/^\d+ commit ([0-9a-f]{40})\t(.+)$/);
      if (m) shaByPath.set(m[2]!, m[1]!);
    }

    const graded = await pmap(mods, 6, async (mod): Promise<SubmodulePin | null> => {
      const pinnedSha = shaByPath.get(mod.path);
      if (!pinnedSha) return null;
      const targetRepo = urlToSlug(mod.url);
      const pin: SubmodulePin = {
        parentRepo: repo.slug,
        path: mod.path,
        url: mod.url,
        targetRepo,
        pinnedSha,
        pinnedDate: null,
        targetDefaultBranch: null,
        onDefaultBranch: null,
        containingBranches: [],
        behindCount: null,
        behindDays: null,
        targetHeadSha: null,
        targetHeadDate: null,
        severity: "ok",
        notes: [],
      };
      if (!targetRepo) {
        pin.notes.push("URL not on github/gitlab; not graded");
        return pin;
      }
      const refs = await lsRemote(targetRepo);
      if (!refs?.headBranch || !refs.headSha) {
        pin.notes.push("target unreachable");
        pin.severity = "info";
        return pin;
      }
      pin.targetDefaultBranch = refs.headBranch;
      pin.targetHeadSha = refs.headSha;

      const havePin = await ensureSha(targetRepo, pinnedSha);
      pin.targetHeadDate = await commitDate(targetRepo, refs.headSha);
      if (!havePin) {
        pin.notes.push("pinned commit not found in target repo");
        pin.severity = "warn";
        return pin;
      }
      pin.pinnedDate = await commitDate(targetRepo, pinnedSha);
      pin.behindCount = await revListCount(targetRepo, pinnedSha, refs.headSha);
      const pinAge = daysAgo(pin.pinnedDate);
      const headAge = daysAgo(pin.targetHeadDate);
      if (pinAge !== null && headAge !== null)
        pin.behindDays = Math.max(0, pinAge - headAge);

      const containing = await branchesContaining(targetRepo, pinnedSha);
      if (containing) {
        pin.containingBranches = containing;
        pin.onDefaultBranch = containing.includes(refs.headBranch);
      }

      let sev: Severity = "ok";
      if (pin.onDefaultBranch === false) {
        sev = worst(sev, th.offBranchSeverity);
        pin.notes.push(
          containing && containing.length > 0
            ? `pin not on '${refs.headBranch}' (on: ${containing.join(", ")})`
            : `pin not reachable from any branch of ${targetRepo}`,
        );
      }
      if (pin.behindDays !== null && pin.behindDays > 0) {
        if (pin.behindDays > th.behindCritDays) sev = worst(sev, "crit");
        else if (pin.behindDays > th.behindWarnDays) sev = worst(sev, "warn");
        else if ((pin.behindCount ?? 0) > 0) sev = worst(sev, "info");
        if ((pin.behindCount ?? 0) > 0)
          pin.notes.push(
            `${pin.behindCount} commits / ${fmtDays(pin.behindDays)} behind ${targetRepo}@${refs.headBranch}`,
          );
      }
      pin.severity = sev;
      return pin;
    });
    pins.push(...graded.filter((p): p is SubmodulePin => p !== null));
  }
  return pins;
}
