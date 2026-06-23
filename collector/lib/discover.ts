// Dynamic repository discovery: expand `orgs:` globs in repos.yaml into
// concrete repositories via the GitHub REST API at collect time, so families
// like ossia/score-addon-* stay covered without hand-maintaining a list.
// Requires a token (org listing is not available over plain git); without one
// it is a no-op and only the explicit `repos:` list is used.

import type { OrgDiscovery, RepoConfig } from "./config.ts";

function globToRe(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

interface ApiRepo {
  full_name: string;
  name: string;
  archived: boolean;
  fork: boolean;
}

export async function discoverOrgRepos(orgs: OrgDiscovery[]): Promise<string[]> {
  if (orgs.length === 0) return [];
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    console.warn("org discovery skipped (no GITHUB_TOKEN); using explicit repo list only");
    return [];
  }
  const headers = {
    authorization: `bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "ossia-dashboard",
  };
  const found = new Set<string>();
  for (const o of orgs) {
    const inc = (o.include ?? ["*"]).map(globToRe);
    const exc = (o.exclude ?? []).map(globToRe);
    for (let page = 1; page <= 20; page++) {
      let arr: ApiRepo[];
      try {
        const res = await fetch(
          `https://api.github.com/orgs/${o.org}/repos?per_page=100&type=all&page=${page}`,
          { headers },
        );
        if (!res.ok) {
          console.warn(`org discovery ${o.org}: HTTP ${res.status}`);
          break;
        }
        arr = (await res.json()) as ApiRepo[];
      } catch (e) {
        console.warn(`org discovery ${o.org}: ${(e as Error).message}`);
        break;
      }
      if (arr.length === 0) break;
      for (const r of arr) {
        if (r.archived && !o.includeArchived) continue;
        if (!inc.some((re) => re.test(r.name))) continue;
        if (exc.some((re) => re.test(r.name))) continue;
        found.add(r.full_name);
      }
      if (arr.length < 100) break;
    }
  }
  return [...found];
}

/** Merge discovered slugs into the explicit repo list, de-duplicated. */
export function mergeRepos(explicit: RepoConfig[], discovered: string[]): RepoConfig[] {
  const have = new Set(explicit.map((r) => r.slug));
  const merged = [...explicit];
  for (const slug of discovered) if (!have.has(slug)) merged.push({ slug });
  return merged;
}
