# ossia / celtera dependency & freshness dashboard — design

Single static dashboard answering, at a glance: **is everything we depend on up to
date, and is everything that depends on us up to date?**

It tracks, across the ossia / celtera / sat-mtl repositories:

1. **Submodule pins** — does each repo's default branch point to a *recent* commit of
   the repos it embeds? Is the pinned commit on the target's default branch, or on
   some side branch?
2. **PR-less branches** — branches with unique commits and no open PR.
3. **PR staleness** — how far behind their base branch open PRs are, and how long
   they have been idle.
4. **3rd-party dependencies (every source)** — a unified inventory that accounts for
   every pinned dependency, not just submodules: `score/3rdparty/deps.yaml` (the
   registry Renovate consumes), shell version files (`ossia/sdk` `common/versions.sh`),
   CMake `FetchContent_Declare` / `ExternalProject_Add` / release-URL pins, and
   `vcpkg.json` ports. Each resolves to an upstream and is graded: pinned version vs
   latest tag, pinned SHA vs upstream HEAD, and pins that track a moving branch
   (`GIT_TAG master`) are flagged as non-reproducible.
5. **Fork revival** — many of our submodules are forks (`jcelerier/*`) of upstreams
   that were dead when we forked. When upstream wakes up again we want a signal.
6. **GitHub Actions** — every `uses:` across every workflow vs the action's latest
   tag; mutable refs (`@master`) flagged.
7. **Build environments** — `runs-on:` runners, container `image:` matrices,
   `Dockerfile.llvm` (`FROM almalinux:9`, pinned CMake), `tools/fetch-sdk.sh`
   (SDK version, boost, CMake) — vs endoflife.date and upstream releases.
   "A newer Ubuntu/Debian exists and is not in the CI matrix" is a first-class signal.
8. **Downstream packaging** — Repology: are distros shipping our latest releases?

## Architecture

```
┌────────────────────────────┐   cron (6h) / dispatch
│ collector (TypeScript)     │──────────────────────────┐
│  transports:               │                          │
│   • git ls-remote / bare   │   data/snapshot.json     ▼
│     partial clones (tree:0)│──────────────► Astro build (SSG, zero JS framework)
│   • GitHub GraphQL/REST    │                          │
│   • HTTPS (repology,       │                          ▼
│     endoflife.date)        │                GitHub Pages deploy
└────────────────────────────┘
```

### Why git-native first

Almost every question is a *git* question, not a GitHub question. `git ls-remote`
is unauthenticated and not rate-limited; bare clones with `--filter=tree:0` download
only the commit graph (no trees/blobs), which is small even for large repos and is
cached between CI runs (`actions/cache` on `~/.cache/ossia-dashboard/gitcache`).
This gives us, cheaply and exactly:

- latest tag and default-branch HEAD of ~150 repos (tracked + upstreams + actions),
- `git rev-list --count pin..head` → "N commits behind",
- commit dates → "N days behind",
- `git branch -r --contains <pin>` → "is the pin on the default branch?",
- fork-point analysis fork vs upstream.

The GitHub API is only needed where git has no answer: open PRs, branch↔PR
association, CI check status. Those are batched over GraphQL (one query per repo).
Repology and endoflife.date are plain JSON-over-HTTPS with long client-side cache.

### Degradation

Every collector is independent and failure-isolated: a transport being unavailable
(no token, blocked host, timeout) marks its section `"source": "fixture" | "stale" |
"unavailable"` in the snapshot instead of failing the build. The committed
`data/snapshot.json` means the site always builds, even from a fresh clone with no
network. CI overwrites it on every scheduled run (committed back so history of the
snapshot is queryable with plain `git log`).

## Data model (`data/snapshot.json`)

```ts
Snapshot {
  schemaVersion, generatedAt, sections: { [name]: { source, collectedAt, error? } },
  repos:        RepoHealth[]     // per-repo rollup for the index strip
  submodules:   SubmodulePin[]   // parent, path, target, pinned sha/date,
                                 // onDefaultBranch, containingBranches,
                                 // behindCount, behindDays, severity
  dependencies: Dependency[]     // unified inventory across all sources
                                 // (deps.yaml, versions.sh, cmake-*, vcpkg):
                                 // source, repo, location, upstream, pinned
                                 // version/sha/ref, tracksBranch, latest tag
                                 // (+date), upstream HEAD date, revived?, severity
  prs:          PullRequest[]    // number, title, base/head, behindBase, ageDays,
                                 // idleDays, draft, ciStatus, severity
  branches:     BranchInfo[]     // ahead/behind default, hasPR, lastCommitDate
  actions:      ActionUse[]      // action → latest tag, every (repo, workflow, ref)
  environments: EnvPin[]         // runners / images / file pins vs latest / EOL
  packaging:    RepologyProject[]
  attention:    AttentionItem[]  // every item with severity ≥ warn, flattened
}
```

Everything carries `severity: ok | info | warn | crit`, assigned by
`collector/lib/severity.ts` from the thresholds in `config/thresholds.yaml`.

### Severity rules (defaults, all configurable)

| signal | info | warn | crit |
|---|---|---|---|
| submodule pin behind target default HEAD | > 0 commits | > 60 days | > 365 days |
| submodule pin not reachable from target default branch | — | always | — |
| dependency pinned tag ≠ upstream latest tag (any source) | newer patch | newer minor/major | — |
| dependency pinned to a moving branch (`GIT_TAG master`) | always | — | — |
| dead-upstream fork: upstream commits < 180 d old, newer than pin | — | always | — |
| branch w/ real unmerged commits (cherry-pick/rebase-aware), no PR | idle < 90 d | idle ≥ 90 d | — |
| open PR | behind base > 0 | idle > 30 d or behind > 50 commits | — |
| action `uses:` ref | mutable ref (`@master`) | behind latest major | — |
| distro image / runner | newer stable release exists, not in matrix | — | EOL |
| file pin (CMake, boost, SDK) | newer release | — | — |
| repology | — | > ⅓ of repos outdated | — |

`config/ignore.yaml` silences known-fine items (e.g. branches matching
`release/*`, intentionally held-back pins) without code changes — every entry
requires a `reason:`.

## Configuration

- `config/repos.yaml` — tracked repositories (org/name, default branch override,
  which collectors apply).
- `config/watch.yaml` — declarative "file pin" watches: file path in a repo, regex
  extractors, and a `latest:` resolver per pin (`git-tag:<owner/repo>`,
  `eol:<product>`, `static:<value>`). This is how `Dockerfile.llvm`,
  `fetch-sdk.sh`, distro matrices, and any future pinned file are tracked —
  adding one is a config edit, not code.
- `config/thresholds.yaml`, `config/ignore.yaml` — see above.
- `config/dependencies.yaml` — the non-submodule dependency sources:
  `versionFiles` (shell version files, mapping each `*_VERSION` var to an
  upstream + tag prefix), `cmakeScan` (repos whose CMake build files are scanned
  for FetchContent/ExternalProject/URL pins), and `vcpkg` (repos with a
  `vcpkg.json` to inventory). The deps.yaml registry is still read from each
  repo's `depsRegistry` in `repos.yaml`, so it stays single-source.

## Site

Astro 6, fully prerendered, no client framework. Performance budget: **< 60 KB
transferred per page, zero render-blocking external requests, no layout shift.**

- System font stack, one hand-written CSS file inlined at build
  (`inlineStylesheets: 'always'`), `prefers-color-scheme` dark/light via CSS
  variables, severity shown as colored dots + text (works without color).
- One ~1.5 KB vanilla script (deferred) adds client-side sort + substring filter to
  tables; everything is readable with JS disabled.
- Repology badges are *not* hotlinked at render time (each SVG is an external
  request); the collector ingests the JSON API instead and we render our own rows.

Pages — `/` is the unified visualization, the rest are drill-downs:

| route | content |
|---|---|
| `/` | attention feed (all warn/crit, grouped by category, worst first) + per-repo health strip (default branch age, counts per category) |
| `/submodules` | full pin matrix across all repos |
| `/dependencies` | unified inventory (deps.yaml, versions.sh, CMake, vcpkg): pinned vs latest, floating-branch + fork-revival sections |
| `/prs` | all open PRs, behind/idle/CI |
| `/branches` | PR-less and stale branches |
| `/actions` | action version matrix + mutable-ref flags |
| `/environments` | runners, container images, Dockerfile.llvm, fetch-sdk.sh, distro EOL timeline |
| `/packaging` | repology per-distro freshness |

## CI (`.github/workflows/build.yml`)

- cron every 6 h + `workflow_dispatch` + push to default branch,
- restore gitcache → `npm run collect` (GITHUB_TOKEN from the workflow) →
  commit refreshed `data/snapshot.json` → `npm run build` → deploy Pages,
- collector failures in one section never fail the build (section marked stale);
  the workflow only fails on build errors.

## Non-goals

- Not a Renovate replacement: Renovate opens the PRs; the dashboard shows global
  state, cross-repo and cross-org, including things Renovate can't see
  (PR-less branches, fork revival, repology, distro matrices).
- No database, no server runtime, no auth: a snapshot JSON in git + static HTML.
