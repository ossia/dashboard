import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const CONFIG_DIR = path.resolve("config");

function load<T>(name: string): T {
  return parse(readFileSync(path.join(CONFIG_DIR, name), "utf8")) as T;
}

export interface RepoConfig {
  slug: string;
  depsRegistry?: string;
  collect?: string[];
}

export interface OrgDiscovery {
  org: string;
  include?: string[]; // name globs, default ["*"]
  exclude?: string[];
  includeArchived?: boolean; // default false
}

export interface WatchPin {
  name: string;
  regex: string;
  latest: string; // "git-tag:owner/repo[#prefix]" | "eol:product" | "none"
}

export interface FileWatch {
  repo: string;
  file: string;
  pins: WatchPin[];
}

export interface VersionVar {
  upstream: string;
  prefix?: string;
}

export interface VersionFile {
  repo: string;
  file: string;
  vars: Record<string, VersionVar>;
}

export interface DependenciesConfig {
  versionFiles: VersionFile[];
  cmakeScan: { repos: string[] };
  vcpkg: { repos: string[] };
}

export interface Config {
  repos: RepoConfig[];
  orgs: OrgDiscovery[];
  ignoreArchived: boolean;
  releaseSources: string[];
  watches: FileWatch[];
  imageProducts: Record<string, string>;
  matrixCoverage: string[];
  repology: string[];
  dependencies: DependenciesConfig;
  thresholds: Thresholds;
  ignore: { match: string; reason: string }[];
}

export interface Thresholds {
  submodule: {
    behindWarnDays: number;
    behindCritDays: number;
    offBranchSeverity: "warn" | "crit";
  };
  upstream: { revivedWindowDays: number };
  branch: { prlessIdleWarnDays: number; staleDays: number };
  pr: { idleWarnDays: number; behindWarnCommits: number };
  actions: { majorsBehindWarn: number };
  environments: { eolSoonDays: number };
}

export function loadConfig(): Config {
  const repos = load<{
    repos: RepoConfig[];
    orgs?: OrgDiscovery[];
    ignoreArchived?: boolean;
    releaseSources?: string[];
  }>("repos.yaml");
  const watch = load<{
    watches: FileWatch[];
    imageProducts: Record<string, string>;
    matrixCoverage: string[];
    repology: string[];
  }>("watch.yaml");
  const dependencies = load<DependenciesConfig>("dependencies.yaml");
  const thresholds = load<Thresholds>("thresholds.yaml");
  const ignore = load<{ ignore: { match: string; reason: string }[] }>("ignore.yaml");
  return {
    repos: repos.repos,
    orgs: repos.orgs ?? [],
    ignoreArchived: repos.ignoreArchived ?? true,
    releaseSources: repos.releaseSources ?? [],
    watches: watch.watches,
    imageProducts: watch.imageProducts,
    matrixCoverage: watch.matrixCoverage,
    repology: watch.repology,
    dependencies: {
      versionFiles: dependencies.versionFiles ?? [],
      cmakeScan: dependencies.cmakeScan ?? { repos: [] },
      vcpkg: dependencies.vcpkg ?? { repos: [] },
    },
    thresholds,
    ignore: ignore.ignore ?? [],
  };
}

export function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}
