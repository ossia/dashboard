// Build-environment freshness:
//   - container images in workflows (debian:trixie, fedora:latest, matrix
//     values behind `ubuntu:${{ matrix.image }}` templates, ...)
//   - `runs-on:` runners (ubuntu-24.04, macos-26, ...)
//   - declarative file pins from config/watch.yaml (Dockerfile.llvm FROM +
//     CMake, fetch-sdk.sh SDK/boost/CMake versions, ...)
// graded against endoflife.date cycles and upstream release tags, including
// "a newer distro cycle exists but is absent from the CI matrix".

import { readFileSync, existsSync } from "node:fs";
import type { Config } from "../lib/config.ts";
import { compareKeys, latestTag, lsRemote, readFileAtHead, versionKey } from "../lib/git.ts";
import type { EnvPin, SectionMeta, Severity } from "../lib/types.ts";
import { worst } from "../lib/severity.ts";
import type { WorkflowFile } from "./actions.ts";

interface EolCycle {
  cycle: string;
  codename?: string;
  releaseDate?: string;
  eol?: string | boolean;
  latest?: string;
}

const eolCache = new Map<string, Promise<EolCycle[] | null>>();
let eolUsedFixture = false;
let eolFailed = false;

function eolData(product: string): Promise<EolCycle[] | null> {
  let p = eolCache.get(product);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`https://endoflife.date/api/${product}.json`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return (await res.json()) as EolCycle[];
        throw new Error(`HTTP ${res.status}`);
      } catch {
        const fixture = `fixtures/eol/${product}.json`;
        if (existsSync(fixture)) {
          eolUsedFixture = true;
          return JSON.parse(readFileSync(fixture, "utf8")) as EolCycle[];
        }
        eolFailed = true;
        return null;
      }
    })();
    eolCache.set(product, p);
  }
  return p;
}

function findCycle(cycles: EolCycle[], value: string): EolCycle | null {
  const v = value.toLowerCase();
  return (
    cycles.find(
      (c) =>
        c.cycle.toLowerCase() === v ||
        c.codename?.toLowerCase() === v ||
        c.codename?.toLowerCase().split(" ")[0] === v,
    ) ?? null
  );
}

function gradeCycle(
  cfg: Config,
  cycles: EolCycle[],
  value: string,
): Pick<EnvPin, "latest" | "eolDate" | "status" | "severity"> {
  const newest = cycles[0]?.cycle ?? null;
  if (/^(latest|rolling|tumbleweed|rawhide|sid|unstable)$/i.test(value))
    return { latest: newest, eolDate: null, status: "current", severity: "ok" };
  const cycle = findCycle(cycles, value);
  if (!cycle)
    return { latest: newest, eolDate: null, status: "unknown", severity: "ok" };
  const eol = typeof cycle.eol === "string" ? cycle.eol : null;
  const now = Date.now();
  let status: EnvPin["status"] = "current";
  let severity: Severity = "ok";
  if (eol && Date.parse(eol) < now) {
    status = "eol";
    severity = "crit";
  } else if (
    eol &&
    Date.parse(eol) < now + cfg.thresholds.environments.eolSoonDays * 86_400_000
  ) {
    status = "eol-soon";
    severity = "warn";
  } else if (newest && cycle.cycle !== newest) {
    status = "behind";
  }
  return { latest: newest, eolDate: eol, status, severity };
}

/** image values per endoflife product found in one workflow file. */
function extractImages(
  cfg: Config,
  wf: WorkflowFile,
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (product: string, value: string) => {
    if (value.includes("${{")) return;
    let s = found.get(product);
    if (!s) found.set(product, (s = new Set()));
    s.add(value);
  };
  // direct image references: ubuntu:24.04, debian:trixie, fedora:latest...
  for (const [prefix, product] of Object.entries(cfg.imageProducts)) {
    const re = new RegExp(
      `(?:image|container):\\s*['"]?${prefix.replace("/", "\\/")}:([A-Za-z0-9._-]+|\\$\\{\\{)`,
      "g",
    );
    for (const m of wf.text.matchAll(re)) add(product, m[1]!);
    // templated matrices: `image: ubuntu:${{ matrix.image }}` with
    // `- { image: 24.04, ... }` entries elsewhere in the same file
    if (wf.text.includes(`${prefix}:\${{`)) {
      for (const m of wf.text.matchAll(/\bimage:\s*['"]?([A-Za-z0-9._-]+)\b/g))
        add(product, m[1]!);
    }
  }
  return found;
}

export async function collectEnvironments(
  cfg: Config,
  workflows: WorkflowFile[],
): Promise<{ pins: EnvPin[]; meta: SectionMeta }> {
  const pins: EnvPin[] = [];
  const seenCyclesByProduct = new Map<string, Set<string>>();

  // --- container images -------------------------------------------------
  // (repo, product, value) -> locations
  const imageRows = new Map<string, { repo: string; product: string; value: string; locs: string[] }>();
  for (const wf of workflows) {
    for (const [product, values] of extractImages(cfg, wf)) {
      for (const value of values) {
        const key = `${wf.repo}|${product}|${value}`;
        let row = imageRows.get(key);
        if (!row) imageRows.set(key, (row = { repo: wf.repo, product, value, locs: [] }));
        if (!row.locs.includes(wf.name)) row.locs.push(wf.name);
      }
    }
  }
  for (const row of imageRows.values()) {
    const cycles = await eolData(row.product);
    const grade = cycles
      ? gradeCycle(cfg, cycles, row.value)
      : { latest: null, eolDate: null, status: "unknown" as const, severity: "ok" as const };
    if (cycles) {
      const c = findCycle(cycles, row.value);
      if (c) {
        let s = seenCyclesByProduct.get(row.product);
        if (!s) seenCyclesByProduct.set(row.product, (s = new Set()));
        s.add(c.cycle);
      }
    }
    pins.push({
      category: "image",
      repo: row.repo,
      location: row.locs.join(", "),
      name: row.product,
      current: row.value,
      missingFromMatrix: [],
      ...grade,
    });
  }

  // --- matrix coverage: newer released cycles absent from CI ------------
  for (const product of cfg.matrixCoverage) {
    const cycles = await eolData(product);
    const seen = seenCyclesByProduct.get(product);
    if (!cycles || !seen || seen.size === 0) continue;
    const seenKeys = [...seen].map(versionKey).filter((k): k is number[] => !!k);
    if (seenKeys.length === 0) continue;
    const maxSeen = seenKeys.reduce((a, b) => (compareKeys(a, b) > 0 ? a : b));
    const missing = cycles
      .filter((c) => {
        const k = versionKey(c.cycle);
        return (
          k &&
          compareKeys(k, maxSeen) > 0 &&
          c.releaseDate &&
          Date.parse(c.releaseDate) < Date.now()
        );
      })
      .map((c) => c.cycle);
    if (missing.length > 0)
      pins.push({
        category: "image",
        repo: "*",
        location: "CI matrix",
        name: `${product} matrix`,
        current: [...seen].sort().join(", "),
        latest: cycles[0]?.cycle ?? null,
        eolDate: null,
        status: "behind",
        missingFromMatrix: missing,
        severity: "info",
      });
  }

  // --- runners -----------------------------------------------------------
  const runnerRows = new Map<string, { repo: string; value: string; locs: string[] }>();
  for (const wf of workflows) {
    for (const m of wf.text.matchAll(/runs-on:\s*['"]?([A-Za-z0-9._-]+)/g)) {
      const value = m[1]!;
      const key = `${wf.repo}|${value}`;
      let row = runnerRows.get(key);
      if (!row) runnerRows.set(key, (row = { repo: wf.repo, value, locs: [] }));
      if (!row.locs.includes(wf.name)) row.locs.push(wf.name);
    }
  }
  for (const row of runnerRows.values()) {
    let grade: Pick<EnvPin, "latest" | "eolDate" | "status" | "severity"> = {
      latest: null,
      eolDate: null,
      status: "unknown",
      severity: "ok",
    };
    const ubuntu = row.value.match(/^ubuntu-([0-9.]+)$/);
    const macos = row.value.match(/^macos-([0-9.]+)$/);
    if (/-latest$/.test(row.value)) grade.status = "current";
    else if (ubuntu) {
      const cycles = await eolData("ubuntu");
      if (cycles) grade = gradeCycle(cfg, cycles, ubuntu[1]!);
    } else if (macos) {
      const cycles = await eolData("macos");
      if (cycles) grade = gradeCycle(cfg, cycles, macos[1]!);
    }
    pins.push({
      category: "runner",
      repo: row.repo,
      location: row.locs.join(", "),
      name: "runs-on",
      current: row.value,
      missingFromMatrix: [],
      ...grade,
    });
  }

  // --- declarative file pins (Dockerfile.llvm, fetch-sdk.sh, ...) --------
  for (const watch of cfg.watches) {
    const text = await readFileAtHead(watch.repo, watch.file);
    if (!text) {
      console.warn(`watch file unreadable: ${watch.repo}:${watch.file}`);
      continue;
    }
    for (const pin of watch.pins) {
      const m = text.match(new RegExp(pin.regex));
      if (!m) {
        console.warn(`pin '${pin.name}' did not match in ${watch.file}`);
        continue;
      }
      const current = m[1]!;
      let grade: Pick<EnvPin, "latest" | "eolDate" | "status" | "severity"> = {
        latest: null,
        eolDate: null,
        status: "unknown",
        severity: "ok",
      };
      if (pin.latest.startsWith("git-tag:")) {
        const [slug, prefix] = pin.latest.slice("git-tag:".length).split("#");
        const refs = await lsRemote(slug!);
        const latest = refs ? latestTag(refs, prefix || undefined) : null;
        if (latest) {
          const lk = versionKey(prefix ? latest.tag.slice(prefix.length) : latest.tag);
          const ck = versionKey(current);
          const behind = lk && ck && compareKeys(lk, ck) > 0;
          grade = {
            latest: latest.tag,
            eolDate: null,
            status: behind ? "behind" : "current",
            severity: behind ? "info" : "ok",
          };
        }
      } else if (pin.latest.startsWith("eol:")) {
        const cycles = await eolData(pin.latest.slice(4));
        if (cycles) {
          grade = gradeCycle(cfg, cycles, current);
          // unlike CI matrices (where older cycles are tested on purpose),
          // a single file pin lagging the newest cycle is worth surfacing
          if (grade.status === "behind" && grade.severity === "ok")
            grade = { ...grade, severity: "info" };
        }
      }
      pins.push({
        category: "file-pin",
        repo: watch.repo,
        location: watch.file,
        name: pin.name,
        current,
        missingFromMatrix: [],
        ...grade,
      });
    }
  }

  // escalate matrix-coverage info onto severity if a watched product is EOL
  for (const p of pins)
    if (p.missingFromMatrix.length > 0) p.severity = worst(p.severity, "info");

  const meta: SectionMeta = {
    source: eolFailed ? "unavailable" : eolUsedFixture ? "fixture" : "live",
    collectedAt: new Date().toISOString(),
    ...(eolUsedFixture || eolFailed
      ? { error: "endoflife.date unreachable; cycle data from committed fixture" }
      : {}),
  };
  return { pins, meta };
}
