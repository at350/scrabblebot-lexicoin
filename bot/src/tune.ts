// Parameter sweep driver: npx tsx src/tune.ts [matches] [seed]
import * as path from "node:path";
import { loadDictionary } from "./engine.js";
import { DEFAULT_PARAMS, type Params } from "./strategy.js";
import { fmt, runMany, strongField, summarize } from "./sim.js";

const n = Number(process.argv[2] ?? 150);
const seed = Number(process.argv[3] ?? 7);
const d = loadDictionary(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "wordlist.txt"));

const variants: Record<string, Partial<Params>> = JSON.parse(process.env.VARIANTS ?? "{}");
if (Object.keys(variants).length === 0) {
  variants["default"] = {};
  for (const cpp of [1.5, 2, 3, 4]) variants[`cpp=${cpp}`] = { coinsPerPoint: cpp };
}
const rows: [string, number, string][] = [];
for (const [name, over] of Object.entries(variants)) {
  const params = { ...DEFAULT_PARAMS, ...over };
  const s = summarize(runMany(d, strongField(params), n, seed), 0);
  rows.push([name, s.meanScore, fmt(s)]);
  console.log(`${name.padEnd(28)} ${fmt(s)}`);
}
rows.sort((a, b) => b[1] - a[1]);
console.log("\nbest:", rows[0]![0], rows[0]![2]);
