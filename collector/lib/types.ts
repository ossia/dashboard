export type Severity = "ok" | "info" | "warn" | "crit";

export interface SectionMeta {
  source: "live" | "fixture" | "unavailable";
  collectedAt: string;
  error?: string;
}

export interface RepoHealth {
  slug: string;
  defaultBranch: string;
  headSha: string;
  headDate: string | null;
  counts: Record<string, { warn: number; crit: number; info: number }>;
}

export interface SubmodulePin {
  parentRepo: string;
  path: string;
  url: string;
  targetRepo: string | null; // owner/name when the URL is a github repo
  pinnedSha: string;
  pinnedDate: string | null;
  targetDefaultBranch: string | null;
  onDefaultBranch: boolean | null;
  containingBranches: string[]; // branches of target containing the pin (max 5)
  behindCount: number | null; // commits between pin and target default HEAD
  behindDays: number | null;
  targetHeadSha: string | null;
  targetHeadDate: string | null;
  severity: Severity;
  notes: string[];
}

export interface UpstreamWatch {
  name: string;
  registry: string; // which deps.yaml section it came from
  upstream: string; // owner/repo or gitlab:owner/repo
  kind: "fork" | "upstream" | "vendored";
  pinnedVersion: string | null;
  pinnedSha: string | null;
  latestTag: string | null;
  latestTagDate: string | null;
  upstreamHeadSha: string | null;
  upstreamHeadDate: string | null;
  outdated: boolean;
  revived: boolean;
  severity: Severity;
  notes: string[];
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  baseRef: string;
  headRef: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  ageDays: number;
  idleDays: number;
  behindBase: number | null;
  aheadOfBase: number | null;
  ciStatus: "success" | "failure" | "pending" | "none" | null;
  severity: Severity;
}

export interface BranchInfo {
  repo: string;
  name: string;
  sha: string;
  lastCommitDate: string | null;
  ahead: number | null; // commits not reachable from the default branch
  aheadReal: number | null; // ahead minus cherry-picked/rebased equivalents
  landedEquivalent: number | null; // unique commits whose patch already landed
  behind: number | null;
  hasPR: boolean | null; // null when PR data was unavailable
  prNumber: number | null;
  severity: Severity;
}

export interface ActionRef {
  repo: string;
  workflow: string;
  ref: string; // as written after @
}

export interface ActionUse {
  action: string; // owner/repo[/path]
  latestTag: string | null;
  refs: ActionRef[];
  mutableRefs: string[]; // refs like master/main found in use
  outdatedRefs: string[]; // refs at least one major behind latestTag
  severity: Severity;
}

export interface EnvPin {
  category: "runner" | "image" | "file-pin";
  repo: string;
  location: string; // workflow or file path
  name: string; // e.g. "ubuntu", "AppImage CMake", "runs-on"
  current: string;
  latest: string | null;
  eolDate: string | null;
  status: "current" | "behind" | "eol-soon" | "eol" | "unknown";
  missingFromMatrix: string[]; // newer cycles absent from CI matrix
  severity: Severity;
}

export interface RepologyRepoVersion {
  repo: string; // distro repo name
  version: string;
  status: string; // newest | outdated | devel | ...
}

export interface RepologyProject {
  project: string;
  newestVersion: string | null;
  total: number;
  outdated: number;
  newest: number;
  versions: RepologyRepoVersion[];
  severity: Severity;
}

export interface AttentionItem {
  id: string; // "<category>:<repo>:<subject>"
  category:
    | "submodule"
    | "upstream"
    | "pr"
    | "branch"
    | "action"
    | "environment"
    | "packaging";
  repo: string;
  subject: string;
  message: string;
  url: string | null;
  severity: Severity;
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  sections: Record<string, SectionMeta>;
  repos: RepoHealth[];
  submodules: SubmodulePin[];
  upstreams: UpstreamWatch[];
  prs: PullRequest[];
  branches: BranchInfo[];
  actions: ActionUse[];
  environments: EnvPin[];
  packaging: RepologyProject[];
  attention: AttentionItem[];
}
