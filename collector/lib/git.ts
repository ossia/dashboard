// git-native transport: ls-remote for refs, bare partial clones
// (--filter=tree:0, commit graph only) for dates / counts / reachability.
// No tokens, no rate limits; clones are cached under .gitcache between runs.

import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

const CACHE_DIR = process.env.GITCACHE_DIR ?? path.resolve(".gitcache");
const GIT_TIMEOUT_MS = Number(process.env.GIT_TIMEOUT_MS ?? 120_000);

/** "owner/repo" or "gitlab:owner/sub/repo" — anything else is not fetchable. */
export function isRepoSlug(s: string): boolean {
  return /^(gitlab:)?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(s);
}

export function repoUrl(slug: string): string {
  // Prefer an existing local checkout's remote (e.g. an authenticated proxy
  // in sandboxed environments) for repos we have on disk.
  const local = localRemoteUrl(slug);
  if (local) return local;
  if (slug.startsWith("gitlab:"))
    return `https://gitlab.com/${slug.slice("gitlab:".length)}`;
  return `https://github.com/${slug}`;
}

const localRemotes = new Map<string, string | null>();

function localRemoteUrl(slug: string): string | null {
  const base = process.env.LOCAL_REPOS_DIR;
  if (!base || slug.startsWith("gitlab:")) return null;
  let url = localRemotes.get(slug);
  if (url !== undefined) return url;
  url = null;
  const name = slug.split("/").pop()!;
  const cfg = path.join(base, name, ".git", "config");
  if (existsSync(cfg)) {
    const m = readFileSync(cfg, "utf8").match(/url\s*=\s*(\S+)/);
    // only trust the local remote if it plausibly serves this repo
    if (m && m[1]!.toLowerCase().includes(slug.toLowerCase())) url = m[1]!;
  }
  localRemotes.set(slug, url);
  return url;
}

/** Authenticate github.com fetches when a token is available (private repos). */
function authFlags(): string[] {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return [];
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=Authorization: Basic ${b64}`];
}

async function git(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

export interface RemoteRefs {
  headBranch: string | null;
  headSha: string | null;
  branches: Map<string, string>; // name -> sha
  tags: Map<string, string>; // name -> sha (peeled when available)
}

const refsCache = new Map<string, Promise<RemoteRefs | null>>();

/** One ls-remote per repo per run: HEAD + heads + tags. */
export function lsRemote(slug: string): Promise<RemoteRefs | null> {
  let p = refsCache.get(slug);
  if (!p) {
    p = lsRemoteUncached(slug);
    refsCache.set(slug, p);
  }
  return p;
}

async function lsRemoteUncached(slug: string): Promise<RemoteRefs | null> {
  try {
    const out = await git([
      ...authFlags(),
      "ls-remote",
      "--symref",
      repoUrl(slug),
      "HEAD",
      "refs/heads/*",
      "refs/tags/*",
    ]);
    const refs: RemoteRefs = {
      headBranch: null,
      headSha: null,
      branches: new Map(),
      tags: new Map(),
    };
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [left, ref] = line.split("\t");
      if (left === undefined || ref === undefined) continue;
      if (left.startsWith("ref:")) {
        // "ref: refs/heads/master\tHEAD"
        refs.headBranch = left.slice(4).trim().replace("refs/heads/", "");
      } else if (ref === "HEAD") {
        refs.headSha = left;
      } else if (ref.startsWith("refs/heads/")) {
        refs.branches.set(ref.slice("refs/heads/".length), left);
      } else if (ref.startsWith("refs/tags/")) {
        const name = ref.slice("refs/tags/".length);
        if (name.endsWith("^{}")) refs.tags.set(name.slice(0, -3), left);
        else if (!refs.tags.has(name)) refs.tags.set(name, left);
      }
    }
    return refs;
  } catch (e) {
    console.warn(`ls-remote failed for ${slug}: ${(e as Error).message}`);
    return null;
  }
}

function cachePath(slug: string): string {
  return path.join(CACHE_DIR, slug.replace(/[:/]/g, "__") + ".git");
}

const cloneCache = new Map<string, Promise<string | null>>();

/**
 * Bare repo with only the commit graph (--filter=tree:0) of all heads.
 * Reused and incrementally fetched across runs.
 */
export function commitGraph(slug: string): Promise<string | null> {
  let p = cloneCache.get(slug);
  if (!p) {
    p = commitGraphUncached(slug);
    cloneCache.set(slug, p);
  }
  return p;
}

async function commitGraphUncached(slug: string): Promise<string | null> {
  const dir = cachePath(slug);
  try {
    if (!existsSync(dir)) {
      mkdirSync(path.dirname(dir), { recursive: true });
      await git([
        ...authFlags(),
        "clone",
        "--bare",
        "--filter=tree:0",
        "--no-tags",
        repoUrl(slug),
        dir,
      ]);
    } else {
      await git(
        [...authFlags(), "fetch", "--filter=tree:0", "--no-tags", "--prune", "origin", "+refs/heads/*:refs/heads/*"],
        { cwd: dir },
      );
    }
    return dir;
  } catch (e) {
    console.warn(`commit-graph clone failed for ${slug}: ${(e as Error).message}`);
    return null;
  }
}

/** Fetch a specific sha into the cached graph (e.g. a submodule pin). */
export async function ensureSha(slug: string, sha: string): Promise<boolean> {
  const dir = await commitGraph(slug);
  if (!dir) return false;
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`], { cwd: dir });
    return true;
  } catch {
    /* not present yet */
  }
  try {
    await git([...authFlags(), "fetch", "--filter=tree:0", "--no-tags", "origin", sha], {
      cwd: dir,
    });
    return true;
  } catch (e) {
    console.warn(`cannot fetch ${sha.slice(0, 12)} from ${slug}: ${(e as Error).message}`);
    return false;
  }
}

export async function commitDate(slug: string, sha: string): Promise<string | null> {
  const dir = await commitGraph(slug);
  if (!dir) return null;
  try {
    const out = await git(["show", "-s", "--format=%cI", sha], { cwd: dir });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function revListCount(
  slug: string,
  from: string,
  to: string,
): Promise<number | null> {
  const dir = await commitGraph(slug);
  if (!dir) return null;
  try {
    const out = await git(["rev-list", "--count", `${from}..${to}`], { cwd: dir });
    return Number(out.trim());
  } catch {
    return null;
  }
}

export async function aheadBehind(
  slug: string,
  base: string,
  head: string,
): Promise<{ ahead: number; behind: number } | null> {
  const dir = await commitGraph(slug);
  if (!dir) return null;
  try {
    const out = await git(
      ["rev-list", "--left-right", "--count", `${base}...${head}`],
      { cwd: dir },
    );
    const m = out.trim().split(/\s+/).map(Number);
    if (m.length !== 2 || m.some(Number.isNaN)) return null;
    return { behind: m[0]!, ahead: m[1]! };
  } catch {
    return null;
  }
}

/** Branches of `slug` whose tip contains `sha` (capped). */
export async function branchesContaining(
  slug: string,
  sha: string,
  cap = 5,
): Promise<string[] | null> {
  const dir = await commitGraph(slug);
  if (!dir) return null;
  try {
    const out = await git(
      ["branch", "--format=%(refname:short)", "--contains", sha],
      { cwd: dir },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, cap);
  } catch {
    return null;
  }
}

/** Read one file from a repo's default branch without a checkout. */
export async function readFileAtHead(
  slug: string,
  file: string,
): Promise<string | null> {
  // raw.githubusercontent is the cheapest path and is mirrored instantly.
  const refs = await lsRemote(slug);
  const branch = refs?.headBranch ?? "master";
  if (!slug.startsWith("gitlab:")) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${slug}/${branch}/${file}`,
      );
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Highest version-looking tag, with optional required prefix. */
export function latestTag(
  refs: RemoteRefs,
  prefix?: string,
): { tag: string; sha: string } | null {
  let best: { tag: string; sha: string; key: number[] } | null = null;
  for (const [tag, sha] of refs.tags) {
    let t = tag;
    if (prefix) {
      if (!t.startsWith(prefix)) continue;
      t = t.slice(prefix.length);
    }
    const key = versionKey(t);
    if (!key) continue;
    if (!best || compareKeys(key, best.key) > 0) best = { tag, sha, key };
  }
  return best ? { tag: best.tag, sha: best.sha } : null;
}

/** Parse "v1.2.3", "1.2", "sdk36", "boost-1.90.0", "1_90_0" → numeric key. */
export function versionKey(v: string): number[] | null {
  const m = v.match(/^[A-Za-z\-_.]*?([0-9][0-9._\-]*)$/);
  if (!m) return null;
  // reject prereleases / rc / beta
  if (/(alpha|beta|rc|pre|dev|test)/i.test(v)) return null;
  const nums = m[1]!.split(/[._\-]/).map(Number);
  if (nums.some(Number.isNaN)) return null;
  return nums;
}

export function compareKeys(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Run jobs with bounded concurrency. */
export async function pmap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}
