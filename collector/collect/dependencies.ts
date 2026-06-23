// Unified third-party dependency inventory. Beyond git submodules (their own
// page), this accounts for every pinned dependency we could find, from five
// kinds of source:
//
//   deps.yaml            score/3rdparty/deps.yaml (the Renovate registry)
//   versions.sh          shell `export NAME=value` pins (ossia/sdk)
//   cmake-fetchcontent   FetchContent_Declare(... GIT_REPOSITORY ... GIT_TAG ...)
//   cmake-externalproject ExternalProject_Add(... GIT_REPOSITORY ... GIT_TAG ...)
//   cmake-url            release-archive URL pins
//   vcpkg                vcpkg.json dependency ports
//
// All of them resolve to an upstream owner/repo plus a pinned version, SHA or
// branch, and run through one grader: latest tag vs pinned version, upstream
// HEAD movement vs a pinned SHA (with dead-upstream "revival" detection), and
// a flag for pins that track a moving branch (master/main) — not reproducible.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Config, VersionFile } from "../lib/config.ts";
import { daysAgo } from "../lib/config.ts";
import {
  commitDate,
  compareKeys,
  ensureSha,
  isRepoSlug,
  latestTag,
  lsRemote,
  pmap,
  readFileAtHead,
  revListCount,
  versionKey,
} from "../lib/git.ts";
import { workTree } from "../lib/worktree.ts";
import { urlToSlug } from "./submodules.ts";
import type { Dependency, DependencySource } from "../lib/types.ts";
import { fmtDays, worst } from "../lib/severity.ts";

const BRANCH_REFS = /^(master|main|HEAD|develop|development|trunk|next|stable|devel)$/i;

function blank(
  name: string,
  source: DependencySource,
  repo: string,
  location: string,
): Dependency {
  return {
    name,
    source,
    repo,
    location,
    upstream: "",
    kind: "vendored",
    pinnedVersion: null,
    pinnedSha: null,
    pinnedRef: null,
    tracksBranch: false,
    latestTag: null,
    latestTagDate: null,
    upstreamHeadSha: null,
    upstreamHeadDate: null,
    defaultBranch: null,
    pinnedRefName: null,
    behindMainCommits: null,
    behindMainDays: null,
    behindLatestCommits: null,
    unreleasedCommits: null,
    unreleasedDays: null,
    outdated: false,
    revived: false,
    severity: "ok",
    notes: [],
  };
}

/** The upstream tag SHA + name that our pinned version refers to, if any. */
function resolvePinnedTag(
  refs: { tags: Map<string, string> },
  d: Dependency,
  prefix?: string,
): { sha: string; name: string } | null {
  if (!d.pinnedVersion) return null;
  // exact name matches first
  for (const cand of [d.pinnedRef, d.pinnedVersion, prefix != null ? prefix + d.pinnedVersion : null]) {
    if (cand && refs.tags.has(cand)) return { sha: refs.tags.get(cand)!, name: cand };
  }
  // otherwise match by numeric key among prefix-respecting tags
  const want = versionKey(d.pinnedVersion);
  if (!want) return null;
  for (const [name, sha] of refs.tags) {
    let t = name;
    if (prefix != null) {
      if (!t.startsWith(prefix)) continue;
      t = t.slice(prefix.length);
      if (!/^[0-9]/.test(t)) continue;
    }
    const k = versionKey(t);
    if (k && k.length === want.length && k.every((n, i) => n === want[i])) {
      return { sha, name };
    }
  }
  return null;
}

/** Fill latest-tag / HEAD fields and grade a dep whose pin fields are set. */
async function grade(cfg: Config, d: Dependency, prefix?: string): Promise<void> {
  if (!d.upstream || !isRepoSlug(d.upstream)) {
    if (!d.notes.length) d.notes.push("no trackable upstream");
    return;
  }
  const refs = await lsRemote(d.upstream);
  if (!refs) {
    d.notes.push("upstream unreachable");
    d.severity = worst(d.severity, "info");
    return;
  }
  d.upstreamHeadSha = refs.headSha;
  if (refs.headSha) d.upstreamHeadDate = await commitDate(d.upstream, refs.headSha);

  // Restrict the "latest" candidate to tags sharing the pinned version's
  // leading non-numeric prefix. Many upstreams carry junk tags ("cppcon2018",
  // "ubuntu16.04", "boost_peer_review4") that otherwise win the numeric max and
  // produce phantom "newer release" alarms. An explicit config prefix wins.
  const pfx =
    prefix ?? (d.pinnedVersion ? (d.pinnedVersion.match(/^[^0-9]*/)?.[0] ?? "") : undefined);
  const latest = latestTag(refs, pfx);
  if (latest) {
    d.latestTag = latest.tag;
    d.latestTagDate = await commitDate(d.upstream, latest.sha);
  }

  // --- commit/day distances: our pin vs latest release vs default branch ---
  // All three are rev-list counts on the commit graph we already cloned, so we
  // just need the pin's and the latest tag's commits present locally.
  d.defaultBranch = refs.headBranch;
  const headSha = refs.headSha;
  let pinSha: string | null = null;
  if (d.pinnedSha) {
    pinSha = (await ensureSha(d.upstream, d.pinnedSha)) ? d.pinnedSha : null;
    d.pinnedRefName = d.pinnedSha;
  } else if (d.pinnedVersion) {
    const t = resolvePinnedTag(refs, d, pfx);
    if (t && (await ensureSha(d.upstream, t.sha))) {
      pinSha = t.sha;
      d.pinnedRefName = t.name;
    }
  }
  const latestSha = latest && (await ensureSha(d.upstream, latest.sha)) ? latest.sha : null;
  if (headSha) {
    if (pinSha) {
      d.behindMainCommits = await revListCount(d.upstream, pinSha, headSha);
      const pa = daysAgo(await commitDate(d.upstream, pinSha));
      const ha = daysAgo(d.upstreamHeadDate);
      if (pa !== null && ha !== null) d.behindMainDays = Math.max(0, Math.round(pa - ha));
    }
    if (pinSha && latestSha) {
      d.behindLatestCommits = await revListCount(d.upstream, pinSha, latestSha);
    }
    if (latestSha) {
      d.unreleasedCommits = await revListCount(d.upstream, latestSha, headSha);
      const la = daysAgo(d.latestTagDate);
      const ha = daysAgo(d.upstreamHeadDate);
      if (la !== null && ha !== null) d.unreleasedDays = Math.max(0, Math.round(la - ha));
    }
  }

  // pinned to a moving branch — reproducibility hazard, like a mutable action ref
  if (d.tracksBranch) {
    d.notes.push(`pinned to moving branch '${d.pinnedRef}'`);
    d.severity = worst(d.severity, "info");
    return;
  }

  // version-tag comparison
  if (d.pinnedVersion) {
    const pk = versionKey(d.pinnedVersion);
    if (!pk) {
      d.notes.push(`pinned to non-release '${d.pinnedVersion}'`);
      d.severity = worst(d.severity, "info");
    } else if (d.latestTag) {
      const lk = versionKey(d.latestTag);
      if (lk && compareKeys(lk, pk) > 0) {
        d.outdated = true;
        d.severity = worst(d.severity, lk[0]! > pk[0]! ? "warn" : "info");
        d.notes.push(`pinned ${d.pinnedVersion}, upstream released ${d.latestTag}`);
      }
    }
  }

  // SHA pin: how far has upstream HEAD moved past it?
  if (d.pinnedSha && refs.headSha) {
    const pinIsHead = refs.headSha.startsWith(d.pinnedSha);
    if (!pinIsHead) {
      const pinnedDate = (await ensureSha(d.upstream, d.pinnedSha))
        ? await commitDate(d.upstream, d.pinnedSha)
        : null;
      const headAge = daysAgo(d.upstreamHeadDate);
      const pinAge = daysAgo(pinnedDate);
      if (headAge !== null && pinAge !== null && pinAge > headAge) {
        d.outdated = true;
        d.notes.push(`upstream HEAD moved ${fmtDays(pinAge - headAge)} past our pin`);
        if (headAge < cfg.thresholds.upstream.revivedWindowDays) {
          d.revived = true;
          d.severity = worst(d.severity, "warn");
          d.notes.push(`upstream active again (last commit ${d.upstreamHeadDate?.slice(0, 10)})`);
        } else {
          d.severity = worst(d.severity, "info");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// source: deps.yaml
// ---------------------------------------------------------------------------
interface DepsEntry {
  name: string;
  upstream?: string;
  upstream_version?: string | number;
  upstream_sha?: string;
}

async function fromDepsRegistry(cfg: Config): Promise<Dependency[]> {
  const out: Dependency[] = [];
  for (const repo of cfg.repos) {
    if (!repo.depsRegistry) continue;
    const text = await readFileAtHead(repo.slug, repo.depsRegistry);
    if (!text) {
      console.warn(`deps registry ${repo.slug}:${repo.depsRegistry} not readable`);
      continue;
    }
    const doc = parse(text) as { deps?: DepsEntry[] };
    const entries = (doc.deps ?? []).filter((e) => e && e.name);
    const graded = await pmap(entries, 8, async (e) => {
      const d = blank(e.name, "deps.yaml", repo.slug, repo.depsRegistry!);
      if (!e.upstream || !isRepoSlug(e.upstream)) {
        d.notes.push(e.upstream ? `vendored: ${e.upstream}` : "vendored, no upstream tracked");
        return d;
      }
      d.upstream = e.upstream;
      d.kind = e.upstream_sha ? "fork" : "upstream";
      d.pinnedVersion = e.upstream_version != null ? String(e.upstream_version) : null;
      d.pinnedSha = e.upstream_sha ?? null;
      d.pinnedRef = d.pinnedSha ?? d.pinnedVersion;
      await grade(cfg, d);
      return d;
    });
    out.push(...graded);
  }
  return out;
}

// ---------------------------------------------------------------------------
// source: versions.sh (shell `export NAME=value`)
// ---------------------------------------------------------------------------
async function fromVersionFiles(cfg: Config): Promise<Dependency[]> {
  const out: Dependency[] = [];
  for (const vf of cfg.dependencies.versionFiles) {
    const text = await readFileAtHead(vf.repo, vf.file);
    if (!text) {
      console.warn(`version file ${vf.repo}:${vf.file} not readable`);
      continue;
    }
    const values = parseShellVars(text);
    const names = Object.keys(vf.vars);
    const graded = await pmap(names, 8, async (varName) => {
      const spec = vf.vars[varName]!;
      const value = values.get(varName);
      const d = blank(varName.replace(/_VERSION$/, "").toLowerCase(), "versions.sh", vf.repo, vf.file);
      d.upstream = spec.upstream;
      d.kind = "upstream";
      if (value === undefined) {
        d.notes.push(`variable ${varName} not found`);
        d.severity = "info";
        return d;
      }
      d.pinnedVersion = value;
      d.pinnedRef = value;
      await grade(cfg, d, spec.prefix);
      return d;
    });
    out.push(...graded);
  }
  return out;
}

function parseShellVars(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("?)([^"#\s]+)\2/);
    if (m) out.set(m[1]!, m[3]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// source: CMake FetchContent / ExternalProject / URL
// ---------------------------------------------------------------------------
function walkCMake(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 8) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === ".git" || e === "node_modules" || e === "3rdparty" || e === "build") continue;
    const full = path.join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkCMake(full, acc, depth + 1);
    else if (e === "CMakeLists.txt" || e.endsWith(".cmake")) acc.push(full);
  }
  return acc;
}

/** substring from the index of '(' to its matching ')'. */
function balanced(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  return text.slice(openParen + 1);
}

interface RawCMakePin {
  name: string;
  source: DependencySource;
  upstream: string;
  ref: string | null; // GIT_TAG
  url: string | null; // URL
}

function parseCMake(text: string): RawCMakePin[] {
  const pins: RawCMakePin[] = [];
  const callRe = /\b(FetchContent_Declare|ExternalProject_Add|CPMAddPackage)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text))) {
    const call = m[1]!;
    const open = m.index + m[0].length - 1;
    const body = balanced(text, open);
    const tokens = body.trim().split(/\s+/);
    let name = tokens[0] && !tokens[0].includes("$") ? tokens[0] : "";
    const nameKv = body.match(/\bNAME\s+"?([^\s")]+)/);
    if (nameKv) name = nameKv[1]!;
    const repo =
      body.match(/GIT_REPOSITORY\s+"?([^\s")]+)/)?.[1] ??
      body.match(/GITHUB_REPOSITORY\s+"?([^\s")]+)/)?.[1] ??
      "";
    const upstream = repo
      ? repo.includes("github.com") || repo.includes("gitlab.com")
        ? (urlToSlug(repo) ?? "")
        : /^[\w.-]+\/[\w.-]+$/.test(repo)
          ? repo // CPM GITHUB_REPOSITORY is already owner/repo
          : ""
      : "";
    const ref =
      body.match(/GIT_TAG\s+"?([^\s")]+)/)?.[1] ??
      body.match(/\bVERSION\s+"?([^\s")]+)/)?.[1] ??
      null;
    const url = body.match(/\bURL\s+"?(https?:\/\/[^\s")]+)/)?.[1] ?? null;
    if (!name) continue;
    if (!upstream && !url) continue;
    const source: DependencySource =
      call === "ExternalProject_Add" ? "cmake-externalproject" : "cmake-fetchcontent";
    pins.push({ name, source: url && !upstream ? "cmake-url" : source, upstream, ref, url });
  }
  return pins;
}

function classifyRef(d: Dependency, ref: string): void {
  d.pinnedRef = ref;
  if (/^[0-9a-f]{7,40}$/i.test(ref) && !/^\d+(\.\d+)+$/.test(ref)) {
    d.pinnedSha = ref;
    d.kind = "fork";
  } else if (BRANCH_REFS.test(ref)) {
    d.tracksBranch = true;
    d.kind = "upstream";
  } else if (versionKey(ref)) {
    d.pinnedVersion = ref;
    d.kind = "upstream";
  } else {
    d.tracksBranch = true; // unknown ref name: treat as a moving target
    d.kind = "upstream";
  }
}

/** github release / archive URL -> { upstream, tag } */
function parseReleaseUrl(url: string): { upstream: string; tag: string } | null {
  let m = url.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//);
  if (m) return { upstream: `${m[1]}/${m[2]}`, tag: m[3]! };
  m = url.match(/github\.com\/([^/]+)\/([^/]+)\/archive\/refs\/tags\/([^/]+?)(?:\.tar\.|\.zip)/);
  if (m) return { upstream: `${m[1]}/${m[2]}`, tag: m[3]! };
  return null;
}

async function fromCMake(cfg: Config): Promise<Dependency[]> {
  const out: Dependency[] = [];
  // scan the configured repos plus every tracked repo (so org-discovered
  // addons get their FetchContent/ExternalProject pins covered too)
  const scan = new Set<string>([
    ...cfg.dependencies.cmakeScan.repos,
    ...cfg.repos.map((r) => r.slug),
  ]);
  for (const slug of scan) {
    const tree = await workTree(slug);
    if (!tree) continue;
    const files = walkCMake(tree);
    const pins: { rel: string; pin: RawCMakePin }[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(tree, file);
      for (const pin of parseCMake(text)) pins.push({ rel, pin });
    }
    const graded = await pmap(pins, 6, async ({ rel, pin }) => {
      const d = blank(pin.name, pin.source, slug, rel);
      if (pin.source === "cmake-url" && pin.url) {
        const parsed = parseReleaseUrl(pin.url);
        if (parsed) {
          d.upstream = parsed.upstream;
          d.pinnedRef = parsed.tag;
          if (versionKey(parsed.tag)) d.pinnedVersion = parsed.tag;
          d.kind = "upstream";
          await grade(cfg, d);
        } else {
          d.notes.push(`URL pin: ${pin.url}`);
        }
        return d;
      }
      d.upstream = pin.upstream;
      if (pin.ref) classifyRef(d, pin.ref);
      await grade(cfg, d);
      return d;
    });
    out.push(...graded);
  }
  return out;
}

// ---------------------------------------------------------------------------
// source: vcpkg.json
// ---------------------------------------------------------------------------
interface VcpkgManifest {
  dependencies?: (string | { name: string; "version>="?: string; features?: string[] })[];
  overrides?: { name: string; version: string }[];
  "builtin-baseline"?: string;
}

async function fromVcpkg(cfg: Config): Promise<Dependency[]> {
  const out: Dependency[] = [];
  for (const slug of cfg.dependencies.vcpkg.repos) {
    const tree = await workTree(slug);
    if (!tree) continue;
    const file = path.join(tree, "vcpkg.json");
    if (!existsSync(file)) continue;
    let manifest: VcpkgManifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8")) as VcpkgManifest;
    } catch {
      console.warn(`vcpkg.json parse failed for ${slug}`);
      continue;
    }
    const overrides = new Map((manifest.overrides ?? []).map((o) => [o.name, o.version]));
    for (const dep of manifest.dependencies ?? []) {
      const name = typeof dep === "string" ? dep : dep.name;
      const d = blank(name, "vcpkg", slug, "vcpkg.json");
      d.kind = "manifest";
      const constraint =
        typeof dep === "object" ? dep["version>="] : undefined;
      const override = overrides.get(name);
      d.pinnedVersion = override ?? constraint ?? null;
      d.pinnedRef = d.pinnedVersion;
      d.notes.push(
        override
          ? `vcpkg override ${override}`
          : constraint
            ? `vcpkg version>=${constraint}`
            : "vcpkg port (registry baseline)",
      );
      out.push(d);
    }
  }
  return out;
}

export async function collectDependencies(cfg: Config): Promise<Dependency[]> {
  const [deps, versions, cmake, vcpkg] = await Promise.all([
    fromDepsRegistry(cfg),
    fromVersionFiles(cfg),
    fromCMake(cfg),
    fromVcpkg(cfg),
  ]);
  return [...deps, ...versions, ...cmake, ...vcpkg];
}
