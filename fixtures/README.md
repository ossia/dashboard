# Fixtures

Fallback data used when a network source is unreachable (sandboxed dev,
network policy). Sections built from fixtures are marked
`"source": "fixture"` in `data/snapshot.json` and flagged in the site
footer. CI always uses live data.

- `eol/*.json` — endoflife.date API responses (trimmed to recent cycles).
- `repology/*.json` — repology.org `/api/v1/project/<name>` responses.
- `prs.json` — raw PR list in the collector's internal shape.
