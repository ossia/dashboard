// Scan every workflow of every tracked repo for `uses: owner/repo@ref`,
// resolve each action's latest tag via ls-remote, and grade:
//   - refs at least one major behind the latest tag  -> warn
//   - mutable refs (@master / @main)                 -> info

import path from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import type { Config } from "../lib/config.ts";
import { compareKeys, latestTag, lsRemote, pmap, versionKey } from "../lib/git.ts";
import { workTree } from "../lib/worktree.ts";
import type { ActionUse, Severity } from "../lib/types.ts";
import { worst } from "../lib/severity.ts";

export interface WorkflowFile {
  repo: string;
  name: string; // file name
  text: string;
}

/** Shared with the environments collector. */
export async function readWorkflows(cfg: Config): Promise<WorkflowFile[]> {
  const out: WorkflowFile[] = [];
  for (const repo of cfg.repos) {
    const tree = await workTree(repo.slug);
    if (!tree) continue;
    const dir = path.join(tree, ".github", "workflows");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      out.push({
        repo: repo.slug,
        name: f,
        text: readFileSync(path.join(dir, f), "utf8"),
      });
    }
  }
  return out;
}

export async function collectActions(
  cfg: Config,
  workflows: WorkflowFile[],
): Promise<ActionUse[]> {
  const byAction = new Map<string, ActionUse>();
  for (const wf of workflows) {
    for (const m of wf.text.matchAll(
      /^\s*-?\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s#]+)/gm,
    )) {
      const action = m[1]!;
      if (action.startsWith("./")) continue;
      let use = byAction.get(action);
      if (!use) {
        use = {
          action,
          latestTag: null,
          refs: [],
          mutableRefs: [],
          outdatedRefs: [],
          severity: "ok",
        };
        byAction.set(action, use);
      }
      use.refs.push({ repo: wf.repo, workflow: wf.name, ref: m[2]! });
    }
  }

  await pmap([...byAction.values()], 8, async (use) => {
    const slug = use.action.split("/").slice(0, 2).join("/");
    const refs = await lsRemote(slug);
    const latest = refs ? latestTag(refs) : null;
    use.latestTag = latest?.tag ?? null;
    const latestKey = latest ? versionKey(latest.tag) : null;

    let sev: Severity = "ok";
    for (const r of use.refs) {
      if (/^(master|main|HEAD)$/.test(r.ref)) {
        if (!use.mutableRefs.includes(r.ref)) use.mutableRefs.push(r.ref);
        sev = worst(sev, "info");
        continue;
      }
      const k = versionKey(r.ref);
      if (k && latestKey) {
        // grade on major only: action tags are commonly floating majors (v4)
        if (latestKey[0]! - k[0]! >= cfg.thresholds.actions.majorsBehindWarn) {
          if (!use.outdatedRefs.includes(r.ref)) use.outdatedRefs.push(r.ref);
          sev = worst(sev, "warn");
        } else if (compareKeys(latestKey, k) > 0 && k.length > 1) {
          // fully-pinned minor/patch behind latest
          sev = worst(sev, "info");
        }
      }
    }
    use.severity = sev;
  });

  return [...byAction.values()].sort((a, b) => a.action.localeCompare(b.action));
}
