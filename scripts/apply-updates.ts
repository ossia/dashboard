// Open (or refresh) one idempotent pull request per proposal in data/update-plan.json.
//
//   npm run apply-updates            # dry run: print what would happen, open nothing
//   npm run apply-updates -- --apply # actually create/update branches and PRs
//
// Requires a write-scoped token in GITHUB_TOKEN (or DASHBOARD_PAT) with access
// to the target repos. Each proposal maps to a stable branch (proposal.branch),
// so re-running advances the same PR instead of opening duplicates; an existing
// OPEN pr for the branch is left in place (its branch is updated), and a
// previously CLOSED pr for the branch is respected (skipped) so we never reopen
// something a maintainer rejected.
//
// The edit is a single, surgical replacement of the pinned ref in the pinned
// file — the same string the inventory extracted. If the current ref is not
// found verbatim (file moved on, already bumped), the proposal is skipped and
// reported rather than guessed at.

import { readFileSync } from "node:fs";
import type { UpdatePlan, UpdateProposal } from "../collector/lib/types.ts";

const APPLY = process.argv.includes("--apply");
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

const plan = JSON.parse(readFileSync("data/update-plan.json", "utf8")) as UpdatePlan;

if (!plan.enabled) {
  console.log("updates disabled in config/updates.yaml; nothing to apply.");
  process.exit(0);
}
if (plan.proposals.length === 0) {
  console.log("no proposals in the current plan.");
  process.exit(0);
}
if (APPLY && !TOKEN) {
  console.error("--apply needs a write-scoped GITHUB_TOKEN / DASHBOARD_PAT.");
  process.exit(1);
}

const api = "https://api.github.com";
const headers = {
  authorization: `bearer ${TOKEN}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "ossia-dashboard-updater",
};

async function gh(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${api}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Replace the pinned ref in the pinned file on a fresh branch, then open a PR. */
async function applyOne(p: UpdateProposal): Promise<string> {
  const [owner, repo] = p.repo.split("/");
  // default branch
  const repoRes = await gh("GET", `/repos/${owner}/${repo}`);
  if (!repoRes.ok) return `skip (repo unreadable: HTTP ${repoRes.status})`;
  const base = ((await repoRes.json()) as { default_branch: string }).default_branch;

  // has a PR for this branch ever existed? (open -> update, closed -> respect)
  const prRes = await gh(
    "GET",
    `/repos/${owner}/${repo}/pulls?state=all&head=${owner}:${p.branch}&per_page=1`,
  );
  const existing = prRes.ok ? ((await prRes.json()) as { state: string; html_url: string }[]) : [];
  if (existing[0]?.state === "closed") return `skip (branch previously closed: ${existing[0].html_url})`;

  // fetch the file, do the surgical replacement
  const fileRes = await gh(
    "GET",
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(p.file)}?ref=${base}`,
  );
  if (!fileRes.ok) return `skip (file unreadable: HTTP ${fileRes.status})`;
  const fileJson = (await fileRes.json()) as { content: string; sha: string };
  const text = Buffer.from(fileJson.content, "base64").toString("utf8");
  if (!text.includes(p.currentRef)) return `skip (current ref '${p.currentRef}' not found in file)`;
  const updated = text.replace(p.currentRef, p.targetRef);

  if (!APPLY) return `would bump ${p.currentRef} -> ${p.targetDisplay} on ${p.branch}`;

  // create/update the branch head from base
  const baseRef = await gh("GET", `/repos/${owner}/${repo}/git/ref/heads/${base}`);
  const baseSha = ((await baseRef.json()) as { object: { sha: string } }).object.sha;
  const mk = await gh("POST", `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${p.branch}`,
    sha: baseSha,
  });
  if (!mk.ok && mk.status !== 422) return `error creating branch: HTTP ${mk.status}`;

  // commit the edit onto the branch (need the file sha on that branch)
  const onBranch = await gh(
    "GET",
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(p.file)}?ref=${p.branch}`,
  );
  const branchFileSha = onBranch.ok
    ? ((await onBranch.json()) as { sha: string }).sha
    : fileJson.sha;
  const put = await gh("PUT", `/repos/${owner}/${repo}/contents/${encodeURIComponent(p.file)}`, {
    message: p.title,
    content: Buffer.from(updated, "utf8").toString("base64"),
    sha: branchFileSha,
    branch: p.branch,
  });
  if (!put.ok) return `error committing: HTTP ${put.status}`;

  if (existing[0]?.state === "open") return `updated existing PR: ${existing[0].html_url}`;
  const body =
    `Automated by the ossia dashboard update planner.\n\n` +
    `- **${p.name}** (${p.source}) in \`${p.file}\`\n` +
    `- ${p.currentRef} → ${p.targetDisplay}\n` +
    (p.compareUrl ? `- upstream diff: ${p.compareUrl}\n` : "") +
    `\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`;
  const pr = await gh("POST", `/repos/${owner}/${repo}/pulls`, {
    title: p.title,
    head: p.branch,
    base,
    body,
  });
  if (!pr.ok) return `error opening PR: HTTP ${pr.status}`;
  return `opened PR: ${((await pr.json()) as { html_url: string }).html_url}`;
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN"}: ${plan.proposals.length} proposals\n`);
for (const p of plan.proposals) {
  let result: string;
  try {
    result = await applyOne(p);
  } catch (e) {
    result = `error: ${(e as Error).message}`;
  }
  console.log(`- ${p.repo} :: ${p.name} → ${p.targetDisplay}: ${result}`);
}
