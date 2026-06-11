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

async function fetchLive(cfg: Config, token: string): Promise<RawPR[]> {
  const all: RawPR[] = [];
  for (const repo of cfg.repos) {
    const [owner, name] = repo.slug.split("/");
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "ossia-dashboard",
      },
      body: JSON.stringify({ query: GQL, variables: { owner, name } }),
    });
    if (!res.ok) throw new Error(`graphql ${repo.slug}: HTTP ${res.status}`);
    const json = (await res.json()) as any;
    if (json.errors?.length) throw new Error(`graphql ${repo.slug}: ${json.errors[0].message}`);
    for (const n of json.data.repository.pullRequests.nodes) {
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
  }
  return all;
}

export async function collectPRs(
  cfg: Config,
): Promise<{ prs: PullRequest[]; meta: SectionMeta }> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  let raw: RawPR[];
  let meta: SectionMeta = { source: "live", collectedAt: new Date().toISOString() };
  try {
    if (!token) throw new Error("no GITHUB_TOKEN");
    raw = await fetchLive(cfg, token);
  } catch (e) {
    const fixture = "fixtures/prs.json";
    if (existsSync(fixture)) {
      raw = JSON.parse(readFileSync(fixture, "utf8")) as RawPR[];
      meta = {
        source: "fixture",
        collectedAt: new Date().toISOString(),
        error: (e as Error).message,
      };
    } else {
      return {
        prs: [],
        meta: {
          source: "unavailable",
          collectedAt: new Date().toISOString(),
          error: (e as Error).message,
        },
      };
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
