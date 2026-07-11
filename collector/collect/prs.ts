// Open PRs via the GitHub GraphQL API (one query per repo, batched fields).
// Ahead/behind vs the base branch is computed git-side: GitHub advertises
// refs/pull/N/head on the base repo, so the commit-graph cache can fetch the
// head SHA even for fork PRs. Falls back to fixtures/prs.json without a token.

import { readFileSync, existsSync } from "node:fs";
import type { Config } from "../lib/config.ts";
import { daysAgo } from "../lib/config.ts";
import { aheadBehind, ensureSha, lsRemote, pmap } from "../lib/git.ts";
import type { PullRequest, SectionMeta, Severity } from "../lib/types.ts";
import { worst } from "../lib/severity.ts";

const GQL = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:100, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number title url isDraft createdAt updatedAt
        baseRefName headRefName headRefOid
        author{login}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      }
    }
  }
}`;

interface RawPR {
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  author: string;
  ciStatus: PullRequest["ciStatus"];
}

async function fetchLive(
  cfg: Config,
  token: string,
): Promise<{ raw: RawPR[]; failed: { repo: string; error: string }[] }> {
  const all: RawPR[] = [];
  const failed: { repo: string; error: string }[] = [];
  // One query per repo, failure-isolated: a repo we can't resolve (private,
  // renamed, no token access) must not discard the live PRs of every other
  // repo — otherwise the whole section falls back to the stale fixture and
  // keeps showing PRs that have since been merged or closed.
  for (const repo of cfg.repos) {
    const [owner, name] = repo.slug.split("/");
    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ossia-dashboard",
        },
        body: JSON.stringify({ query: GQL, variables: { owner, name } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as any;
      if (json.errors?.length) throw new Error(json.errors[0].message);
      const nodes = json.data?.repository?.pullRequests?.nodes ?? [];
      for (const n of nodes) {
        const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
        all.push({
          repo: repo.slug,
          number: n.number,
          title: n.title,
          url: n.url,
          isDraft: n.isDraft,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          baseRefName: n.baseRefName,
          headRefName: n.headRefName,
          headRefOid: n.headRefOid,
          author: n.author?.login ?? "?",
          ciStatus:
            rollup === "SUCCESS"
              ? "success"
              : rollup === "FAILURE" || rollup === "ERROR"
                ? "failure"
                : rollup === "PENDING" || rollup === "EXPECTED"
                  ? "pending"
                  : rollup === null
                    ? "none"
                    : null,
        });
      }
    } catch (e) {
      failed.push({ repo: repo.slug, error: (e as Error).message });
      console.warn(`prs: skipping ${repo.slug}: ${(e as Error).message}`);
    }
  }
  return { raw: all, failed };
}

export async function collectPRs(
  cfg: Config,
): Promise<{ prs: PullRequest[]; meta: SectionMeta }> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const now = () => new Date().toISOString();
  let raw: RawPR[];
  let meta: SectionMeta = { source: "live", collectedAt: now() };

  // Fall back to the committed fixture ONLY when live data is truly
  // unobtainable (no token, or every repo failed). A frozen fixture lists PRs
  // that may since have merged/closed, so it must never mask partial success.
  const fallback = (reason: string): { prs: RawPR[]; meta: SectionMeta } | null => {
    const fixture = "fixtures/prs.json";
    if (existsSync(fixture)) {
      return {
        prs: JSON.parse(readFileSync(fixture, "utf8")) as RawPR[],
        meta: { source: "fixture", collectedAt: now(), error: reason },
      };
    }
    return null;
  };

  if (!token) {
    const fb = fallback("no GITHUB_TOKEN");
    if (!fb) return { prs: [], meta: { source: "unavailable", collectedAt: now(), error: "no GITHUB_TOKEN" } };
    raw = fb.prs;
    meta = fb.meta;
  } else {
    const { raw: live, failed } = await fetchLive(cfg, token);
    if (failed.length === cfg.repos.length) {
      // every repo failed → live data is unusable; use the fixture if present
      const reason = failed.map((f) => `${f.repo}: ${f.error}`).join("; ");
      const fb = fallback(reason);
      if (!fb) return { prs: [], meta: { source: "unavailable", collectedAt: now(), error: reason } };
      raw = fb.prs;
      meta = fb.meta;
    } else {
      // live: some repos may be unreachable, but the rest are current — their
      // merged/closed PRs correctly disappear. Note the skipped ones.
      raw = live;
      meta = failed.length
        ? {
            source: "live",
            collectedAt: now(),
            error: `${failed.length} repo(s) unreachable, skipped: ${failed.map((f) => f.repo).join(", ")}`,
          }
        : { source: "live", collectedAt: now() };
    }
  }

  const th = cfg.thresholds.pr;
  const prs = await pmap(raw, 6, async (p): Promise<PullRequest> => {
    let behindBase: number | null = null;
    let aheadOfBase: number | null = null;
    const refs = await lsRemote(p.repo);
    const baseSha = refs?.branches.get(p.baseRefName);
    if (baseSha && p.headRefOid && (await ensureSha(p.repo, p.headRefOid))) {
      const ab = await aheadBehind(p.repo, baseSha, p.headRefOid);
      if (ab) {
        behindBase = ab.behind;
        aheadOfBase = ab.ahead;
      }
    }
    const ageDays = daysAgo(p.createdAt) ?? 0;
    const idleDays = daysAgo(p.updatedAt) ?? 0;
    let severity: Severity = "ok";
    if ((behindBase ?? 0) > 0) severity = worst(severity, "info");
    if (idleDays > th.idleWarnDays || (behindBase ?? 0) > th.behindWarnCommits)
      severity = worst(severity, "warn");
    if (p.isDraft && severity === "warn") severity = "info"; // drafts are expected to linger
    return {
      repo: p.repo,
      number: p.number,
      title: p.title,
      author: p.author,
      url: p.url,
      baseRef: p.baseRefName,
      headRef: p.headRefName,
      draft: p.isDraft,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      ageDays: Math.round(ageDays * 10) / 10,
      idleDays: Math.round(idleDays * 10) / 10,
      behindBase,
      aheadOfBase,
      ciStatus: p.ciStatus,
      severity,
    };
  });
  return { prs, meta };
}
