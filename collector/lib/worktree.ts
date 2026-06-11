// Shallow working copies of *tracked* repos, used to enumerate workflow
// files, read .gitmodules and run `git ls-tree` for submodule pins.
//
// If LOCAL_REPOS_DIR is set and contains a checkout of the repo (the case in
// dev sandboxes where the repos are already cloned), it is used directly;
// otherwise a depth-1 clone with small blobs only is cached in .gitcache.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { authFlags, repoUrl } from "./git.ts";

const execFileP = promisify(execFile);
const CACHE_DIR = process.env.GITCACHE_DIR ?? path.resolve(".gitcache");
const LOCAL = process.env.LOCAL_REPOS_DIR;

const cache = new Map<string, Promise<string | null>>();

export function workTree(slug: string): Promise<string | null> {
  let p = cache.get(slug);
  if (!p) {
    p = workTreeUncached(slug);
    cache.set(slug, p);
  }
  return p;
}

async function workTreeUncached(slug: string): Promise<string | null> {
  const name = slug.split("/").pop()!;
  if (LOCAL && existsSync(path.join(LOCAL, name, ".git"))) {
    return path.join(LOCAL, name);
  }
  const dir = path.join(CACHE_DIR, "worktrees", slug.replace(/[:/]/g, "__"));
  try {
    if (!existsSync(dir)) {
      mkdirSync(path.dirname(dir), { recursive: true });
      await execFileP(
        "git",
        [...authFlags(), "clone", "--depth=1", "--filter=blob:limit=262144", "--no-tags", repoUrl(slug), dir],
        { cwd: path.dirname(dir), timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
      );
    } else {
      await execFileP("git", [...authFlags(), "fetch", "--depth=1", "origin"], { cwd: dir, timeout: 300_000 });
      await execFileP("git", ["reset", "--hard", "origin/HEAD"], { cwd: dir, timeout: 60_000 });
    }
    return dir;
  } catch (e) {
    console.warn(`worktree clone failed for ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export async function gitInTree(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd: dir,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
