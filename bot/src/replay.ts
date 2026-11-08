// Replay evaluator: re-runs recorded live matches with our strategy inserted
// as a seventh, virtual bidder against the recorded top bids.
//
//   npx tsx src/replay.ts [matches=150] [seed=1] [options]
//     --seeds K             deals sampled per match (default 3)
//     --params k=v,...      overrides applied to every variant
//     --vs k=v,...          add a variant (repeatable): base + these overrides
//     --sweep key=a,b,c     one variant per value (repeatable, one key each)
//     --workers N           worker processes (default: cores - 2)
//     --verbose             per-match lines for the base variant
//     --ours                replay matches our bot really played (from
//                           `pull_matches.ts --ours`) and compare with its
//                           recorded score: a check of the method itself
//
// Why this is valid: in a sealed-bid Vickrey auction the other bots' bids
// don't depend on ours, so we win a tile iff our bid beats the recorded top
// bid (ties split uniformly with everyone who bid that much) and then pay
// that top bid, which becomes the second price. Otherwise nothing changes for
// us. Approximations: the tiles we take stay in the recorded winners' racks
// (their scores are left as recorded), our 5-tile deal is sampled from the 30
// tiles the recorded bots were dealt, and opponents' balances and scores are
// the recorded ones reconstructed over time.
//
// Every variant replays the same deals and tie draws, so differences between
// variants are paired and far less noisy than the absolute numbers.
//
// Data comes from `pull_matches.ts` (bot/data/replay/*.json).

import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BAG_COUNTS, emptyRack, letterIndex, loadDictionary, rackClone, rackRemoveWord, rackTotal, type Dictionary, type Rack } from "./engine.js";
import { DEFAULT_PARAMS, decideBid, decidePlays, type MatchView, type Params } from "./strategy.js";
import { rng } from "./sim.js";
import { DATA_DIR, OURS_DIR, OUR_BOT_ID, TOP_BOTS, type ReplayMatch } from "./pull_matches.js";

interface Job {
  variant: number;
  dir: string;
  matchId: number;
  seed: number; // per-deal seed, shared by all variants
  params: Params;
}

export interface ReplayResult {
  variant: number;
  matchId: number;
  seed: number;
  score: number;
  balance: number;
  tiles: number;
  spent: number;
  words: string[];
  recorded: { botId: number; name: string; score: number }[];
  actual?: number; // our bot's real score, when it played this match
}

const SELF = path.resolve(new URL(import.meta.url).pathname);
const WORDLIST = path.join(path.dirname(SELF), "..", "..", "data", "wordlist.txt");

// A match our bot really played: take it out, leaving the others' bids.
// Where it won, the price it paid was the best of the other bids.
function withoutUs(m: ReplayMatch): { match: ReplayMatch; actual?: number } {
  const us = m.participants.find((p) => p.botId === OUR_BOT_ID);
  if (!us) return { match: m };
  return {
    actual: us.score,
    match: {
      ...m,
      participants: m.participants.filter((p) => p.botId !== OUR_BOT_ID),
      plays: m.plays.filter((p) => p.botId !== OUR_BOT_ID),
      auctions: m.auctions.map((a) => (a.winner === OUR_BOT_ID ? { ...a, topBid: a.paid, paid: 0, winner: null } : a)),
    },
  };
}

function loadMatch(dir: string, id: number): { match: ReplayMatch; actual?: number } {
  return withoutUs(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")));
}

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function replayMatch(d: Dictionary, m: ReplayMatch, params: Params, seed: number): Omit<ReplayResult, "variant"> {
  // The 30 tiles dealt to the recorded bots: the bag minus everything auctioned.
  const dealt = new Int32Array(BAG_COUNTS);
  for (const a of m.auctions) dealt[letterIndex(a.letter)]--;
  const r = rng(mix(m.matchId, seed));
  const initial = emptyRack();
  for (let k = 0; k < 5; k++) {
    let idx = r.int(0, rackTotal(dealt) - 1);
    for (let c = 0; c < 26; c++) {
      if (idx < dealt[c]!) {
        dealt[c]--;
        initial[c]++;
        break;
      }
      idx -= dealt[c]!;
    }
  }

  let rack: Rack = rackClone(initial);
  let balance = 100;
  let score = 0;
  let tiles = 0;
  let spent = 0;
  const words: string[] = [];
  const auctioned = emptyRack();

  // Opponents' balances and scores over time, from the recorded events.
  const opp = new Map(m.participants.map((p) => [p.botId, { balance: 100, score: 0 }]));
  const events: { t: number; bot: number; delta: number; reward: boolean }[] = [];
  for (const a of m.auctions) if (a.winner !== null) events.push({ t: a.closesAt, bot: a.winner, delta: -a.paid, reward: false });
  for (const p of m.plays) events.push({ t: p.playedAt, bot: p.botId, delta: p.reward, reward: true });
  events.sort((x, y) => x.t - y.t);
  let ev = 0;
  const advance = (t: number) => {
    for (; ev < events.length && events[ev]!.t <= t; ev++) {
      const e = events[ev]!;
      const o = opp.get(e.bot);
      if (!o) continue;
      o.balance += e.delta;
      if (e.reward) o.score += e.delta;
    }
  };

  const view = (bagRemaining: number): MatchView => {
    const pool = emptyRack();
    for (let c = 0; c < 26; c++) pool[c] = BAG_COUNTS[c]! - initial[c]! - auctioned[c]!;
    return {
      rack,
      balance,
      score,
      bagRemaining,
      pool,
      auctionType: "Vickrey",
      opponents: [...opp.values()].map((o) => ({ balance: o.balance, score: o.score })),
    };
  };

  const n = m.auctions.length;
  m.auctions.forEach((a, i) => {
    const c = letterIndex(a.letter);
    auctioned[c]++;
    const bagRemaining = n - i - 1;
    advance(a.opensAt);
    const bid = Math.max(0, Math.min(balance, Math.floor(decideBid(d, a.letter, view(bagRemaining), params).amount)));
    let win = false;
    if (bid > 0) {
      if (bid > a.topBid) win = true;
      else if (bid === a.topBid) {
        // Tied at the top: the module shuffles, so each tied bidder is
        // equally likely. paid == topBid means at least two others tied.
        const others = a.paid === a.topBid ? 2 : 1;
        win = rng(mix(mix(m.matchId, seed), i + 1)).next() < 1 / (others + 1);
      }
    }
    if (win) {
      const price = a.topBid > 0 ? a.topBid : Math.min(1, bid);
      balance -= price;
      spent += price;
      tiles++;
      rack = rackClone(rack);
      rack[c]++;
    }
    // The last close ends the match instantly: nobody plays after it.
    if (bagRemaining > 0) {
      advance(a.closesAt);
      for (let guard = 0; guard < 8; guard++) {
        const plays = decidePlays(d, view(bagRemaining), params);
        if (plays.length === 0) break;
        for (const w of plays) {
          rack = rackRemoveWord(rack, w.word);
          balance += w.reward;
          score += w.reward;
          words.push(w.word);
        }
      }
    }
  });

  return {
    matchId: m.matchId,
    seed,
    score,
    balance,
    tiles,
    spent,
    words,
    recorded: m.participants.map((p) => ({ botId: p.botId, name: p.name, score: p.score })),
  };
}

// ---------- worker ----------

function runWorker() {
  const d = loadDictionary(WORDLIST);
  const cache = new Map<number, ReturnType<typeof loadMatch>>();
  process.on("message", (job: Job | { done: true }) => {
    if ("done" in job) process.exit(0);
    let m = cache.get(job.matchId);
    if (!m) cache.set(job.matchId, (m = loadMatch(job.dir, job.matchId)));
    const res: ReplayResult = { variant: job.variant, ...replayMatch(d, m.match, job.params, job.seed), actual: m.actual };
    process.send!(res);
  });
  process.send!({ ready: true });
}

async function runJobs(jobs: Job[], workers: number): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  if (workers <= 1) {
    const d = loadDictionary(WORDLIST);
    for (const j of jobs) {
      const m = loadMatch(j.dir, j.matchId);
      out.push({ variant: j.variant, ...replayMatch(d, m.match, j.params, j.seed), actual: m.actual });
    }
    return out;
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, jobs.length) }, () => {
      return new Promise<void>((resolve, reject) => {
        const child = fork(SELF, ["--worker"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
        const feed = () => {
          if (next < jobs.length) child.send(jobs[next++]!);
          else {
            child.send({ done: true });
            resolve();
          }
        };
        child.on("message", (msg: ReplayResult | { ready: true }) => {
          if (!("ready" in msg)) out.push(msg);
          feed();
        });
        child.on("error", reject);
        child.on("exit", (code) => (code !== 0 ? reject(new Error(`worker exited ${code}`)) : resolve()));
      });
    }),
  );
  return out;
}

// ---------- reporting ----------

function rankOf(r: ReplayResult): { rank: number; better: number } {
  const better = r.recorded.filter((p) => p.score > r.score).length;
  const tied = r.recorded.filter((p) => p.score === r.score).length;
  return { rank: 1 + better + tied / 2, better };
}

function meanSe(xs: number[]): [number, number] {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  return [mean, Math.sqrt(v / n)];
}

const key = (r: ReplayResult) => `${r.matchId}:${r.seed}`;

function summaryLine(name: string, rs: ReplayResult[], base: ReplayResult[] | null): string {
  const [score, se] = meanSe(rs.map((r) => r.score));
  const ranks = rs.map(rankOf);
  const mean = (f: (r: ReplayResult, i: number) => number) => rs.reduce((a, r, i) => a + f(r, i), 0) / rs.length;
  let delta = "";
  if (base) {
    const bm = new Map(base.map((r) => [key(r), r.score]));
    const [dm, dse] = meanSe(rs.map((r) => r.score - bm.get(key(r))!));
    delta = ` Δ=${dm >= 0 ? "+" : ""}${dm.toFixed(1)}±${dse.toFixed(1)}`;
  }
  return (
    `${name.padEnd(26)} score=${score.toFixed(1)}±${se.toFixed(1)}${delta.padEnd(13)} rank=${mean((_, i) => ranks[i]!.rank).toFixed(2)}` +
    ` win=${(mean((_, i) => (ranks[i]!.better === 0 ? 1 : 0)) * 100).toFixed(0)}% top2=${(mean((_, i) => (ranks[i]!.better <= 1 ? 1 : 0)) * 100).toFixed(0)}%` +
    ` tiles=${mean((r) => r.tiles).toFixed(1)} spent=${mean((r) => r.spent).toFixed(0)} left=${mean((r) => r.balance).toFixed(1)}`
  );
}

function parseKv(s: string): Partial<Params> {
  const out: Record<string, number | boolean> = {};
  for (const part of s.split(",").filter(Boolean)) {
    const [k, v] = part.split("=");
    if (!k || v === undefined || !(k in DEFAULT_PARAMS)) throw new Error(`unknown param: ${part}`);
    out[k] = v === "true" ? true : v === "false" ? false : Number(v);
  }
  return out as Partial<Params>;
}

async function main() {
  const args = process.argv.slice(2);
  const pos: string[] = [];
  let seeds = 3;
  let workers = Math.max(1, os.cpus().length - 2);
  let verbose = false;
  let dir = DATA_DIR;
  let base: Partial<Params> = {};
  const variants: { name: string; over: Partial<Params> }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--seeds") seeds = Number(args[++i]);
    else if (a === "--workers") workers = Number(args[++i]);
    else if (a === "--verbose") verbose = true;
    else if (a === "--ours") dir = OURS_DIR;
    else if (a === "--params") base = { ...base, ...parseKv(args[++i]!) };
    else if (a === "--vs") variants.push({ name: args[i + 1]!, over: parseKv(args[++i]!) });
    else if (a === "--sweep") {
      const [k, vals] = args[++i]!.split("=");
      for (const v of vals!.split(",")) variants.push({ name: `${k}=${v}`, over: parseKv(`${k}=${v}`) });
    } else pos.push(a);
  }
  const nMatches = Number(pos[0] ?? 150);
  const seed = Number(pos[1] ?? 1);
  const all = [
    { name: Object.keys(base).length ? "base" : "default", over: {} as Partial<Params> },
    ...variants,
  ];

  const ids = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => Number(f.slice(0, -5)))
    .sort((a, b) => b - a)
    .slice(0, nMatches);
  const jobs: Job[] = [];
  all.forEach((v, vi) => {
    const params = { ...DEFAULT_PARAMS, ...base, ...v.over };
    for (const id of ids) for (let s = 0; s < seeds; s++) jobs.push({ variant: vi, dir, matchId: id, seed: seed * 1000 + s, params });
  });
  const t0 = performance.now();
  const results = await runJobs(jobs, workers);
  const secs = (performance.now() - t0) / 1000;
  const by = all.map((_, vi) => results.filter((r) => r.variant === vi).sort((a, b) => a.matchId - b.matchId || a.seed - b.seed));
  const baseRs = by[0]!;

  if (verbose) {
    const perMatch = new Map<number, ReplayResult[]>();
    for (const r of baseRs) {
      if (!perMatch.has(r.matchId)) perMatch.set(r.matchId, []);
      perMatch.get(r.matchId)!.push(r);
    }
    for (const [id, rs] of perMatch) {
      const rec = rs[0]!.recorded.map((p) => p.score).sort((a, b) => b - a);
      const ours = rs.map((r) => r.score);
      const rank = rs.reduce((a, r) => a + rankOf(r).rank, 0) / rs.length;
      const winner = rs[0]!.recorded.reduce((a, b) => (b.score > a.score ? b : a));
      const actual = rs[0]!.actual !== undefined ? ` actual=${rs[0]!.actual}` : "";
      console.log(
        `${id} ours=${ours.join("/").padEnd(12)}${actual} rank=${rank.toFixed(1)} rec=[${rec.join(" ")}] best=${winner.name}(${winner.botId}) words=${rs[0]!.words.join(",")}`,
      );
    }
    console.log("");
  }

  // The recorded field, for scale.
  const recBest = meanSe(baseRs.map((r) => Math.max(...r.recorded.map((p) => p.score))))[0];
  const recMean = meanSe(baseRs.flatMap((r) => r.recorded.map((p) => p.score)))[0];
  console.log(`${ids.length} matches x ${seeds} deals x ${all.length} variants (${jobs.length} replays, ${workers} workers, ${secs.toFixed(1)}s)`);
  console.log(`recorded field: winner mean ${recBest.toFixed(1)}, all-bot mean ${recMean.toFixed(1)}`);
  if (Object.keys(base).length) console.log(`base params: ${JSON.stringify(base)}`);
  all.forEach((v, vi) => console.log(summaryLine(v.name, by[vi]!, vi === 0 ? null : baseRs)));
  const real = baseRs.filter((r) => r.actual !== undefined);
  if (real.length) {
    // Our bot's real result in the same matches, ranked the same way.
    const actual = real.map((r) => ({ ...r, score: r.actual! }));
    console.log(summaryLine("actual (recorded 199)", actual, null).replace(/ tiles=.*/, ""));
    const [dm, dse] = meanSe(real.map((r) => r.score - r.actual!));
    console.log(`replayed - actual: ${dm.toFixed(1)}±${dse.toFixed(1)}`);
  }

  // Ours vs each top bot in the matches it played.
  const vsTop: string[] = [];
  for (const bot of TOP_BOTS) {
    const rs = baseRs.filter((r) => r.recorded.some((p) => p.botId === bot));
    if (rs.length < 3 * seeds) continue;
    const theirs = rs.reduce((a, r) => a + r.recorded.find((p) => p.botId === bot)!.score, 0) / rs.length;
    const ours = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    const beat = rs.filter((r) => r.score > r.recorded.find((p) => p.botId === bot)!.score).length / rs.length;
    const name = rs[0]!.recorded.find((p) => p.botId === bot)!.name;
    vsTop.push(`${name}(${bot}) n=${rs.length / seeds} them=${theirs.toFixed(0)} us=${ours.toFixed(0)} beat=${(beat * 100).toFixed(0)}%`);
  }
  console.log(`\nvs top bots (${all[0]!.name}):\n  ${vsTop.join("\n  ")}`);
}

if (process.argv.includes("--worker")) runWorker();
else if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
