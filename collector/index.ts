// Orchestrator: runs every collector (failure-isolated), grades everything,
// and writes data/snapshot.json for the Astro build.

import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, daysAgo } from "./lib/config.ts";
import { commitDate, lsRemote } from "./lib/git.ts";
import type { SectionMeta, Snapshot } from "./lib/types.ts";
import { buildAttention, rollupRepoCounts } from "./lib/severity.ts";
import { collectSubmodules } from "./collect/submodules.ts";
import { collectUpstreams } from "./collect/upstreams.ts";
import { collectPRs } from "./collect/prs.ts";
import { collectBranches } from "./collect/branches.ts";
import { collectActions, readWorkflows } from "./collect/actions.ts";
import { collectEnvironments } from "./collect/environments.ts";
import { collectRepology } from "./collect/repology.ts";

const cfg = loadConfig();
const t0 = Date.now();

function liveMeta(): SectionMeta {
  return { source: "live", collectedAt: new Date().toISOString() };
}

async function section<T>(
  name: string,
  fallback: T,
  fn: () => Promise<{ data: T; meta: SectionMeta }>,
): Promise<{ data: T; meta: SectionMeta }> {
  const start = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return r;
  } catch (e) {
    console.error(`✗ ${name}: ${(e as Error).stack ?? e}`);
    return {
      data: fallback,
      meta: {
        source: "unavailable",
        collectedAt: new Date().toISOString(),
        error: (e as Error).message,
      },
    };
  }
}

// repo health strip: default branch + head freshness
const repos = await section("repos", [], async () => ({
  data: await Promise.all(
    cfg.repos.map(async (r) => {
      const refs = await lsRemote(r.slug);
      const headSha = refs?.headSha ?? "";
      return {
        slug: r.slug,
        defaultBranch: refs?.headBranch ?? "?",
        headSha,
        headDate: headSha ? await commitDate(r.slug, headSha) : null,
        counts: {},
      };
    }),
  ),
  meta: liveMeta(),
}));

const workflows = await readWorkflows(cfg);

const [submodules, upstreams, prsRes, actions, environments, packaging] =
  await Promise.all([
    section("submodules", [], async () => ({
      data: await collectSubmodules(cfg),
      meta: liveMeta(),
    })),
    section("upstreams", [], async () => ({
      data: await collectUpstreams(cfg),
      meta: liveMeta(),
    })),
    section("prs", [], async () => {
      const r = await collectPRs(cfg);
      return { data: r.prs, meta: r.meta };
    }),
    section("actions", [], async () => ({
      data: await collectActions(cfg, workflows),
      meta: liveMeta(),
    })),
    section("environments", [], async () => {
      const r = await collectEnvironments(cfg, workflows);
      return { data: r.pins, meta: r.meta };
    }),
    section("packaging", [], async () => {
      const r = await collectRepology(cfg);
      return { data: r.projects, meta: r.meta };
    }),
  ]);

const branches = await section("branches", [], async () => ({
  data: await collectBranches(cfg, prsRes.data, prsRes.meta.source !== "unavailable"),
  meta: prsRes.meta.source === "unavailable" ? { ...liveMeta(), error: "PR association unavailable" } : liveMeta(),
}));

const snapshot: Snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sections: {
    repos: repos.meta,
    submodules: submodules.meta,
    upstreams: upstreams.meta,
    prs: prsRes.meta,
    branches: branches.meta,
    actions: actions.meta,
    environments: environments.meta,
    packaging: packaging.meta,
  },
  repos: repos.data,
  submodules: submodules.data,
  upstreams: upstreams.data,
  prs: prsRes.data,
  branches: branches.data,
  actions: actions.data,
  environments: environments.data,
  packaging: packaging.data,
  attention: [],
};

snapshot.attention = buildAttention(snapshot, cfg);
rollupRepoCounts(snapshot);

mkdirSync("data", { recursive: true });
writeFileSync("data/snapshot.json", JSON.stringify(snapshot, null, 1) + "\n");

const stale = daysAgo(snapshot.generatedAt);
void stale;
console.log(
  `snapshot written: ${snapshot.attention.length} attention items, ` +
    `${snapshot.submodules.length} submodule pins, ${snapshot.upstreams.length} upstream watches, ` +
    `${snapshot.prs.length} PRs, ${snapshot.branches.length} branches, ` +
    `${snapshot.actions.length} actions, ${snapshot.environments.length} env pins ` +
    `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
console.log(
  "section sources: " +
    Object.entries(snapshot.sections)
      .map(([k, m]) => `${k}=${m.source}`)
      .join(" "),
);
for (const [k, m] of Object.entries(snapshot.sections))
  if (m.source !== "live" && m.error) console.warn(`  ${k}: ${m.error}`);
