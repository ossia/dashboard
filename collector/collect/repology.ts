// Downstream packaging freshness via the Repology API: which distro repos
// ship our projects, and how many are behind the newest released version.
// This is the "are others up to date with us" half of the dashboard.

import { readFileSync, existsSync } from "node:fs";
import type { Config } from "../lib/config.ts";
import type { RepologyProject, SectionMeta, Severity } from "../lib/types.ts";

interface RepologyPackage {
  repo: string;
  version: string;
  status?: string;
  srcname?: string;
  visiblename?: string;
}

export async function collectRepology(
  cfg: Config,
): Promise<{ projects: RepologyProject[]; meta: SectionMeta }> {
  const projects: RepologyProject[] = [];
  let usedFixture = false;
  let failed: string | null = null;

  for (const name of cfg.repology) {
    let pkgs: RepologyPackage[] | null = null;
    try {
      const res = await fetch(`https://repology.org/api/v1/project/${name}`, {
        headers: { "user-agent": "ossia-dashboard (jmcelerier@sat.qc.ca)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pkgs = (await res.json()) as RepologyPackage[];
    } catch (e) {
      const fixture = `fixtures/repology/${name}.json`;
      if (existsSync(fixture)) {
        pkgs = JSON.parse(readFileSync(fixture, "utf8")) as RepologyPackage[];
        usedFixture = true;
      } else {
        failed = (e as Error).message;
        continue;
      }
    }

    const newest = pkgs.find((p) => p.status === "newest")?.version ?? null;
    const outdated = pkgs.filter((p) => p.status === "outdated").length;
    const newestCount = pkgs.filter((p) => p.status === "newest").length;
    const total = pkgs.filter((p) =>
      ["newest", "outdated", "legacy", "devel", "unique"].includes(p.status ?? ""),
    ).length;
    let severity: Severity = "ok";
    if (total > 0 && outdated > total / 3) severity = "warn";
    else if (outdated > 0) severity = "info";
    projects.push({
      project: name,
      newestVersion: newest,
      total,
      outdated,
      newest: newestCount,
      versions: pkgs
        .filter((p) => p.status && p.status !== "rolling")
        .map((p) => ({ repo: p.repo, version: p.version, status: p.status! }))
        .sort((a, b) => a.repo.localeCompare(b.repo)),
      severity,
    });
  }

  const meta: SectionMeta = {
    source: failed && projects.length === 0 ? "unavailable" : usedFixture ? "fixture" : "live",
    collectedAt: new Date().toISOString(),
    ...(failed || usedFixture
      ? { error: failed ?? "repology.org unreachable; data from committed fixture" }
      : {}),
  };
  return { projects, meta };
}
