// Multi-seed / multi-field sweep driver (tuning helper, not used by the live bot).
//
//   VARIANTS='{"name":{"param":value},...}' \
//   FIELD=strong|mixed AUCTION=Vickrey|FirstPrice SEEDS=1,2 BASE='{...}' \
//   npx tsx src/tune2.ts <matches>
//
// Prints one row per variant per seed plus a pooled row, sorted by pooled
// mean score. BASE overrides DEFAULT_PARAMS before the variants are applied.
import * as path from "node:path";
import { loadDictionary } from "./engine.js";
import { DEFAULT_PARAMS, type Params } from "./strategy.js";
import { fmt, mixedField, runMany, strongField, summarize, type MatchResult } from "./sim.js";

const n = Number(process.argv[2] ?? 200);
const seeds = (process.env.SEEDS ?? "1").split(",").map(Number);
const field = (process.env.FIELD ?? "strong") as "strong" | "mixed";
const auction = (process.env.AUCTION ?? "Vickrey") as "Vickrey" | "FirstPrice";
const base: Partial<Params> = JSON.parse(process.env.BASE ?? "{}");
const d = loadDictionary(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "wordlist.txt"));

const variants: Record<string, Partial<Params>> = JSON.parse(process.env.VARIANTS ?? '{"default":{}}');
const rows: [string, number, string][] = [];
const t0 = performance.now();
for (const [name, over] of Object.entries(variants)) {
  const params = { ...DEFAULT_PARAMS, ...base, ...over };
  const all: MatchResult[] = [];
  const perSeed: string[] = [];
  for (const seed of seeds) {
    const mk = field === "strong" ? strongField(params) : mixedField(params);
    const res = runMany(d, mk, n, seed, auction);
    all.push(...res);
    const s = summarize(res, 0);
    perSeed.push(`s${seed}:${s.meanScore.toFixed(1)}/${(s.winRate * 100).toFixed(0)}%`);
  }
  const s = summarize(all, 0);
  rows.push([name, s.meanScore, fmt(s)]);
  console.log(`${name.padEnd(30)} ${fmt(s)}  [${perSeed.join(" ")}]`);
}
rows.sort((a, b) => b[1] - a[1]);
console.log(`\n${field}/${auction} n=${n}x${seeds.length} seeds, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
console.log("best:", rows[0]![0], rows[0]![2]);
