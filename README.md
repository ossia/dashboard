# ossia dashboard

A freshness dashboard for the **ossia / celtera / sat-mtl** repositories. It
answers, at a glance: *is everything we depend on up to date, and is everything
that depends on us up to date?*

It tracks, across every configured repo:

- **submodule pins** — freshness vs the target repo, and whether the pin is even
  on the target's default branch;
- **third-party dependencies** — a unified inventory from `deps.yaml`, shell
  version files (`versions.sh`), CMake `FetchContent`/`ExternalProject`/release
  URLs, and `vcpkg.json`, each graded against the upstream's latest tag and HEAD,
  with commit-distance columns (vs main / vs latest / latest→main) and
  fork-revival + floating-branch detection;
- **open PRs** — behind-base and idle time;
- **branches** — real unmerged commits (cherry-pick/rebase aware), PR-less;
- **GitHub Actions** — `uses:` versions and mutable refs;
- **build environments** — CI distro images / runners, `Dockerfile.llvm`,
  `tools/fetch-sdk.sh`, vs endoflife.date and upstream releases;
- **downstream packaging** — Repology, per project.

Everything is graded `ok / info / warn / crit` and the index page is a single
attention feed of everything at `warn` or above.

**Architecture and the data model live in [DESIGN.md](DESIGN.md).** This README
is the operations guide: how to run it and, above all, **how to keep it
up to date** as the projects change.

---

## Running it locally

```bash
npm install
npm run collect   # gather data  → data/snapshot.json
npm run build     # render site   → dist/
npm run dev       # live preview at http://localhost:4321/dashboard
npm run check     # type-check the collector + site
```

`collect` and `build` are independent: `build` just renders whatever is in
`data/snapshot.json`. You can edit configs, re-run `collect`, and rebuild without
touching the network beyond what `collect` itself fetches.

### Environment variables for `collect`

| var | effect |
|---|---|
| `GITHUB_TOKEN` | enables live PR data (GraphQL), org discovery, and private-repo access. Without it those degrade gracefully (PRs fall back to `fixtures/prs.json`, org discovery is skipped). |
| `DASHBOARD_PAT` | CI only: a PAT that takes precedence over `GITHUB_TOKEN`, used to reach private repos in **other** orgs (e.g. `sat-mtl/*`) that the workflow token can't see. |
| `LOCAL_REPOS_DIR` | if set, the collector uses existing checkouts at `$LOCAL_REPOS_DIR/<repo-name>` instead of cloning. Handy for fast local iteration when the repos are already on disk. |
| `GITCACHE_DIR` | where bare commit-graph clones are cached (default `.gitcache`). CI persists this across runs with `actions/cache`. |
| `DASHBOARD_BASE` | site base path (default `/dashboard`; set to `/` for a custom domain). |

A normal local run with a token:

```bash
GITHUB_TOKEN=ghp_xxx npm run collect && npm run build
```

Every section is **failure-isolated**: if a transport is unavailable (no token,
blocked host, timeout), that section is marked `fixture` or `unavailable` in the
snapshot and flagged in the site banner — the build never fails because of it.
The `collect` log ends with a `section sources:` line so you can see at a glance
which sections were live.

---

## How to update things

Almost everything is driven by the five files in `config/`. **Adding coverage is
a config edit, not code.** Each recipe below is self-contained.

### Configuration files at a glance

| file | what it controls |
|---|---|
| `config/repos.yaml` | which repositories are tracked + dynamic org discovery |
| `config/dependencies.yaml` | non-submodule dependency sources (version files, CMake scan, vcpkg) |
| `config/watch.yaml` | watched file pins, CI image→EOL mapping, matrix coverage, Repology projects |
| `config/thresholds.yaml` | severity thresholds |
| `config/ignore.yaml` | silenced findings (false positives) |

---

### 1. Track a new repository

Add it to the `repos:` list in `config/repos.yaml`:

```yaml
repos:
  - slug: ossia/score
    depsRegistry: 3rdparty/deps.yaml   # optional: path to a deps.yaml registry
  - slug: ossia/my-new-repo            # ← new
```

That one line opts the repo into **every** collector: submodules, branches, PRs,
actions, and CMake dependency scanning. `depsRegistry` is only needed if the repo
contains a `deps.yaml`-style registry (currently only `ossia/score` does).

The default branch is detected automatically (`master` vs `main`, etc.) — you
never specify it.

### 2. Auto-track a whole family of repositories (org discovery)

Instead of listing dozens of repos by hand, expand a name glob across an org. In
`config/repos.yaml`:

```yaml
orgs:
  - org: ossia
    include:
      - "score-addon-*"     # globs: * and ? supported
      - "ossia-*"
    exclude:
      - "*-deprecated"
    includeArchived: false  # default false; archived repos are skipped
```

At collect time the GitHub API is queried and every matching repo is added to the
tracked set (deduped against the explicit `repos:` list). **This needs a token**
(`GITHUB_TOKEN`); without one it is silently skipped and only the explicit list is
used. Private repos appear only if the token can see them.

> Cost note: each discovered repo is cloned (shallow) and ls-remoted by the
> collectors. The `.gitcache` makes subsequent runs cheap, but the first run after
> adding a broad glob will be slower.

### 3. Add a third-party dependency

Dependencies come from five source kinds. Pick the one that matches how the
dependency is pinned.

#### a. It's in `score/3rdparty/deps.yaml`

Nothing to do here — that registry is read automatically from every repo that
declares `depsRegistry:` in `repos.yaml`. To add or fix an entry, edit
`deps.yaml` **in the score repo** (it is the single source of truth, also consumed
by Renovate). An entry looks like:

```yaml
  - name: fmt
    upstream: fmtlib/fmt          # owner/repo, or gitlab:owner/repo
    upstream_version: "10.2.1"    # for tag-tracked deps
  - name: some-fork
    upstream: original/project
    upstream_sha: "a1b2c3d4e5f6"  # for SHA-tracked forks
```

#### b. It's a shell version variable (e.g. `ossia/sdk` `common/versions.sh`)

These are `export NAME_VERSION=value` lines. Map each variable to its upstream in
`config/dependencies.yaml`:

```yaml
versionFiles:
  - repo: ossia/sdk
    file: common/versions.sh
    vars:
      SDL_VERSION:    { upstream: libsdl-org/SDL, prefix: "release-" }
      FFMPEG_VERSION: { upstream: FFmpeg/FFmpeg,  prefix: "n" }
      MESON_VERSION:  { upstream: mesonbuild/meson }   # prefix omitted = bare tags
```

`prefix` is the string the upstream puts in front of the numeric version in its
git **tags** (e.g. SDL tags releases `release-2.32.10`, so `prefix: "release-"`).
The pinned value in the file is usually the bare number; the prefix tells the
collector which tag namespace to compare against. Getting the prefix right is the
difference between a correct "latest" and a phantom one — see
[*Fixing a wrong "latest"*](#fixing-a-wrong-latest) below.

To track a **new** version file, add another entry under `versionFiles`. The repo
does not need to be in `repos.yaml` (the file is fetched directly).

#### c. It's a CMake `FetchContent` / `ExternalProject` / release URL

**Automatic.** Every tracked repo's `*.cmake` and `CMakeLists.txt` files are
scanned for:

- `FetchContent_Declare(name GIT_REPOSITORY <url> GIT_TAG <ref>)`
- `ExternalProject_Add(name GIT_REPOSITORY <url> GIT_TAG <ref>)`
- `URL "https://github.com/owner/repo/releases/download/<tag>/..."`

`GIT_TAG` is classified as a version tag, a commit SHA, or a **floating branch**
(`master`/`main` — flagged as non-reproducible). So just make sure the repo
containing the CMake file is tracked (recipe 1 or 2). To scan a repo that is *not*
otherwise tracked, add it under `cmakeScan` in `config/dependencies.yaml`:

```yaml
cmakeScan:
  repos:
    - some-org/some-repo
```

(Tracked repos are always scanned; this list is only for extra ones.)

#### d. It's a `vcpkg.json` port

Add the repo under `vcpkg` in `config/dependencies.yaml`:

```yaml
vcpkg:
  repos:
    - sat-mtl/carto-tcp-avendish
```

Ports are inventoried with any version overrides. vcpkg resolves ports against a
registry baseline rather than a git tag, so these are listed for completeness and
not version-compared.

### 4. Watch a pinned version inside a file (Dockerfile, scripts, …)

For arbitrary pins in arbitrary files — a base image, a hard-coded CMake version,
an SDK tag — use a regex watch in `config/watch.yaml`:

```yaml
watches:
  - repo: ossia/score
    file: cmake/Deployment/Linux/AppImage/Dockerfile.llvm
    pins:
      - name: AppImage base image
        regex: 'FROM\s+almalinux:(\S+)'      # exactly one capture group = current value
        latest: eol:almalinux                # resolver, see below
      - name: AppImage CMake
        regex: 'cmake-([0-9.]+)-linux'
        latest: git-tag:Kitware/CMake        # highest semver tag of that repo
```

The `latest:` resolver is one of:

| resolver | meaning |
|---|---|
| `git-tag:<owner/repo>` | highest version-looking git tag |
| `git-tag:<owner/repo>#<prefix>` | …restricted to tags starting with `<prefix>` |
| `eol:<product>` | an [endoflife.date](https://endoflife.date) product; reports EOL status + newest cycle |
| `none` | just surface the value, no comparison |

The regex must have **exactly one capture group** (the current value). These
appear on the **environments** page.

### 5. Track a CI distro image or runner

Container `image:` values and `runs-on:` runners are extracted from every
workflow automatically. To grade a distro against EOL dates, map its image prefix
to an endoflife.date product in `config/watch.yaml`:

```yaml
imageProducts:
  ubuntu: ubuntu
  debian: debian
  fedora: fedora
  almalinux: almalinux
  opensuse/leap: opensuse
```

To also get a *"a newer release exists but isn't in the CI matrix"* signal for a
distro family, list it under `matrixCoverage`:

```yaml
matrixCoverage:
  - ubuntu
  - debian
  - fedora
```

### 6. Add a Repology (downstream packaging) project

In `config/watch.yaml`, add the repology project **slug** — the last path segment
of `repology.org/project/<slug>/versions` (check the project's repology page or
its README packaging badge):

```yaml
repology:
  - ossia-score
  - libossia
  - libremidi
  - avendish
```

A slug with no downstream packages renders harmlessly as "no data".

### 7. Tune severity thresholds

All thresholds live in `config/thresholds.yaml` (days unless noted). For example,
to consider a submodule critical only after two years and warn open PRs sooner:

```yaml
submodule:
  behindCritDays: 730
pr:
  idleWarnDays: 14
```

See the file for the full set (submodule behind/off-branch, fork-revival window,
branch idle, PR idle/behind, action majors-behind, environment EOL window).

### 8. Silence a false positive

When a finding is known-fine, add an entry to `config/ignore.yaml`. The `match`
is a substring of the attention item **id** (`<category>:<repo>:<subject>`, shown
implicitly on the page; the format is in `collector/lib/severity.ts`). **Every
entry requires a `reason:`.**

```yaml
ignore:
  - match: "branch:ossia/score:gh-pages"
    reason: generated documentation branch, never has a PR
  - match: "dependency:ossia/score:deps.yaml:some-lib"
    reason: intentionally held back pending API migration (see #1234)
```

Ignored items are removed from the attention feed but still appear (ungraded) in
their detail table.

---

### Fixing a wrong "latest"

If a dependency shows a nonsensical "latest tag" (e.g. a date or a conference
codename), the upstream has junk tags polluting version detection. Two levers:

1. **Give it a prefix.** For version files use `prefix:` (recipe 3b); for file
   watches use `git-tag:<repo>#<prefix>` (recipe 4). The collector then only
   considers tags beginning with that prefix and starting with a digit after it.
2. For `deps.yaml` the prefix is **derived automatically** from the pinned
   version's own leading non-digits (e.g. pinning `v3.11.0` only matches `v*`
   tags). If that still picks junk, the pinned value and the real tags disagree on
   format — fix the `deps.yaml` entry to use the upstream's actual tag string.

The "latest" selection rejects anything that isn't `<prefix><digits...>`, and
ignores prerelease tags (alpha/beta/rc/dev). If a project's stable releases *are*
tagged with such words, that's the one case needing a code tweak in
`collector/lib/git.ts` (`versionKey`).

---

## Secrets & permissions (CI)

The deploy workflow (`.github/workflows/build.yml`) needs:

- **`GITHUB_TOKEN`** — provided automatically by Actions. The workflow grants it
  `contents: write` (to commit the refreshed snapshot), `pull-requests: read`
  (PR data), and Pages permissions. This covers all **public** repos and the
  dashboard repo itself.
- **`DASHBOARD_PAT`** *(optional)* — a fine-grained PAT with read access to
  private repos in other orgs (e.g. `sat-mtl/*`). Add it under
  *Settings → Secrets and variables → Actions*. When present it is used instead of
  `GITHUB_TOKEN` for collection, so private cross-org repos are covered. Without
  it, those repos are simply skipped (logged, not fatal).

## Deployment

- **First-time setup:** in the repo settings, set *Pages → Source: GitHub
  Actions*, and ensure `main` is the default branch (scheduled workflows only run
  from the default branch).
- The workflow runs on a **6-hour cron**, on **push to the default branch**, and
  on **manual dispatch** (*Actions → collect & deploy → Run workflow*). It
  re-collects, commits the refreshed `data/snapshot.json` (so the snapshot's
  history is queryable with plain `git log`), builds, and deploys to Pages.
- To force an immediate refresh, trigger the workflow manually or push any commit.

## Adding a brand-new kind of check

The config recipes cover new *data* within existing checks. A genuinely new
**category** (a new collector) is a small amount of code:

1. add a `collect/<name>.ts` that returns typed rows;
2. add the type + a `Snapshot` field in `collector/lib/types.ts`;
3. call it from `collector/index.ts` (wrap in `section(...)` for failure
   isolation);
4. emit attention items + per-repo rollup in `collector/lib/severity.ts`;
5. add a page under `src/pages/` and a nav entry in `src/components/Layout.astro`.

The existing collectors are small and parallel-structured; copy the closest one.
See [DESIGN.md](DESIGN.md) for the data model and the git-native helper layer
(`collector/lib/git.ts`: `lsRemote`, `commitGraph`, `revListCount`,
`aheadBehind`, `latestTag`, …).

## Troubleshooting

| symptom | cause / fix |
|---|---|
| a section shows a "non-live data" banner | the transport was unavailable during collect; check the `section sources:` line and the warnings under it in the collect log. PRs need a token; repology/endoflife.date need network egress to those hosts. |
| PRs are from a fixture | no `GITHUB_TOKEN`, or the workflow lacks `pull-requests: read`. |
| a private/cross-org repo is missing | add `DASHBOARD_PAT` (see Secrets). |
| `score-addon-*` (or other family) not appearing | org discovery needs a token; confirm the `orgs:` glob and that the repo isn't archived (or set `includeArchived: true`). |
| a dependency's "latest" looks wrong | see [*Fixing a wrong "latest"*](#fixing-a-wrong-latest). |
| a CMake/version dep is missing entirely | confirm its repo is tracked (so its CMake files are scanned) or listed under `cmakeScan`/`versionFiles`; check the collect log for `did not match` / `not readable` warnings. |
| the site builds but data is stale | `build` only renders `data/snapshot.json`; run `collect` first (CI does this automatically). |

The fork→upstream registry is **not** duplicated in this repo: it is read from
`ossia/score:3rdparty/deps.yaml`, the same file Renovate consumes.
