# ossia dashboard

Dependency & freshness dashboard for the ossia / celtera / sat-mtl
repositories: submodule pins, 3rd-party upstreams & fork revival, open PRs,
PR-less branches, GitHub Actions versions, build environments
(distro images, `Dockerfile.llvm`, `fetch-sdk.sh`) and downstream packaging
(Repology).

**Design:** see [DESIGN.md](DESIGN.md).

## How it works

```
npm run collect   # → data/snapshot.json  (git ls-remote + partial clones,
                  #   GitHub GraphQL with GITHUB_TOKEN, repology, endoflife.date)
npm run build     # → dist/               (Astro, fully static, no client framework)
npm run dev       # local preview
```

A scheduled workflow (every 6 h) re-collects, commits the refreshed
snapshot and deploys to GitHub Pages. Each data section degrades
independently: without a token or network, sections fall back to committed
fixtures (marked in the page banner) instead of failing the build.

Useful environment variables for `npm run collect`:

| var | effect |
|---|---|
| `GITHUB_TOKEN` | enables live PR data (GraphQL) and private-repo access; in CI an optional `DASHBOARD_PAT` secret takes precedence to reach private repos outside the org |
| `LOCAL_REPOS_DIR` | use existing checkouts at `$dir/<name>` instead of cloning |
| `GITCACHE_DIR` | where bare commit-graph clones are cached (default `.gitcache`) |
| `DASHBOARD_BASE` | site base path (default `/dashboard`) |

## Configuration

| file | purpose |
|---|---|
| `config/repos.yaml` | which repositories are tracked |
| `config/watch.yaml` | watched file pins (Dockerfile.llvm, fetch-sdk.sh, …), image→EOL product map, matrix coverage, repology projects |
| `config/thresholds.yaml` | severity thresholds |
| `config/ignore.yaml` | silenced findings (each needs a `reason:`) |

The fork→upstream registry is **not** duplicated here: it is read from
`ossia/score:3rdparty/deps.yaml`, the same file Renovate consumes.
