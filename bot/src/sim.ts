// Offline simulator of the ScrabbleBot match rules, with opponents modelled
// on observed real-bot bidding (a ~10 coin floor plus a premium for letter
// value) and the module's own simulated bots. Used to tune `strategy.ts`.
//
//   npx tsx src/sim.ts [matches] [seed]

import * as path from "node:path";
import {
  BAG_COUNTS,
  LETTER_VALUE,
  bestPlayable,
  emptyRack,
  greedyCashOut,
  indexLetter,
  loadDictionary,
  rackClone,
  rackRemoveWord,
  rackTotal,
  type Dictionary,
  type Rack,
} from "./engine.js";
import { DEFAULT_PARAMS, decideBid, decidePlays, type MatchView, type Params } from "./strategy.js";

// Deterministic PRNG (mulberry32).
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const gauss = () => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, int, gauss };
}
export type Rng = ReturnType<typeof rng>;

export type OpponentKind =
  | { kind: "ours"; params: Params }
  | { kind: "model"; a: number; b: number; sigma: number; skip: number; completeBoost: number; name: string }
  | { kind: "sim"; strategy: "Cheapskate" | "ValueBidder" | "Aggressive" };

interface Player {
  spec: OpponentKind;
  rack: Rack;
  balance: number;
  score: number;
  initialRack: Rack;
  words: string[];
}

export interface MatchResult {
  scores: number[];
  balances: number[];
  words: string[][];
  tilesWon: number[];
  spent: number[];
}

function drawFromBag(bag: Rack, r: Rng): number {
  const total = rackTotal(bag);
  let idx = r.int(0, total - 1);
  for (let c = 0; c < 26; c++) {
    if (idx < bag[c]!) {
      bag[c]--;
      return c;
    }
    idx -= bag[c]!;
  }
  throw new Error("empty bag");
}

function simBid(strategy: "Cheapskate" | "ValueBidder" | "Aggressive", c: number, balance: number, r: Rng): number {
  const v = LETTER_VALUE[c]!;
  const vowel = "AEIOU".includes(indexLetter(c));
  let base: number;
  switch (strategy) {
    case "Cheapskate":
      base = v - 1;
      break;
    case "ValueBidder":
      base = v;
      break;
    case "Aggressive":
      base = v + (vowel ? 4 : 2);
      break;
  }
  const jitter = r.int(-2, 2);
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

function modelBid(d: Dictionary, p: Player, spec: Extract<OpponentKind, { kind: "model" }>, c: number, bagRemaining: number, r: Rng): number {
  if (bagRemaining <= 0) return 0;
  if (r.next() < spec.skip) return 0;
  const v = LETTER_VALUE[c]!;
  let bid = spec.a + spec.b * v + spec.sigma * r.gauss();
  // Boost when the letter completes a long word right away.
  if (spec.completeBoost > 0) {
    const withL = rackClone(p.rack);
    withL[c]++;
    const now = bestPlayable(d, p.rack, 7)?.reward ?? 0;
    const then = bestPlayable(d, withL, 7)?.reward ?? 0;
    if (then > now) bid += spec.completeBoost * (then - now);
  }
  // Spend down near the end.
  if (bagRemaining <= 5) bid = Math.max(bid, p.balance / (bagRemaining + 1));
  return Math.max(0, Math.min(p.balance, Math.round(bid)));
}

function modelPlay(d: Dictionary, p: Player, bagRemaining: number) {
  if (bagRemaining <= 1) {
    for (const w of greedyCashOut(d, p.rack, 2)) applyPlay(p, w.word, w.reward);
    return;
  }
  for (;;) {
    const best = bestPlayable(d, p.rack, 7);
    if (!best) break;
    applyPlay(p, best.word, best.reward);
  }
  if (p.balance < 10) {
    const best = bestPlayable(d, p.rack, 5);
    if (best && best.reward >= 15) applyPlay(p, best.word, best.reward);
  }
}

function applyPlay(p: Player, word: string, reward: number) {
  p.rack = rackRemoveWord(p.rack, word);
  p.balance += reward;
  p.score += reward;
  p.words.push(word);
}

export function runMatch(d: Dictionary, specs: OpponentKind[], r: Rng, auctionType: "Vickrey" | "FirstPrice" = "Vickrey"): MatchResult {
  const bag = new Int32Array(BAG_COUNTS);
  const players: Player[] = specs.map((spec) => ({ spec, rack: emptyRack(), balance: 100, score: 0, initialRack: emptyRack(), words: [] }));
  for (const p of players) {
    for (let i = 0; i < 5; i++) {
      const c = drawFromBag(bag, r);
      p.rack[c]++;
    }
    p.initialRack = rackClone(p.rack);
  }
  const auctioned = emptyRack();
  const tilesWon = players.map(() => 0);
  const spent = players.map(() => 0);

  const viewFor = (p: Player, bagRemaining: number): MatchView => {
    const pool = emptyRack();
    for (let c = 0; c < 26; c++) pool[c] = BAG_COUNTS[c]! - p.initialRack[c]! - auctioned[c]!;
    return {
      rack: p.rack,
      balance: p.balance,
      score: p.score,
      bagRemaining,
      pool,
      auctionType,
      opponents: players.filter((q) => q !== p).map((q) => ({ balance: q.balance, score: q.score })),
    };
  };

  const oursPlay = (p: Player, bagRemaining: number) => {
    const params = (p.spec as { params: Params }).params;
    for (let guard = 0; guard < 8; guard++) {
      const plays = decidePlays(d, viewFor(p, bagRemaining), params);
      if (plays.length === 0) break;
      for (const w of plays) applyPlay(p, w.word, w.reward);
    }
  };

  while (rackTotal(bag) > 0) {
    const c = drawFromBag(bag, r);
    auctioned[c]++;
    const bagRemaining = rackTotal(bag);
    const letter = indexLetter(c);
    const bids: { i: number; amount: number }[] = [];
    players.forEach((p, i) => {
      let amount = 0;
      switch (p.spec.kind) {
        case "ours":
          amount = decideBid(d, letter, viewFor(p, bagRemaining), p.spec.params).amount;
          break;
        case "model":
          amount = modelBid(d, p, p.spec, c, bagRemaining, r);
          break;
        case "sim":
          amount = simBid(p.spec.strategy, c, p.balance, r);
          break;
      }
      amount = Math.max(0, Math.min(p.balance, Math.floor(amount)));
      if (amount > 0) bids.push({ i, amount });
    });
    // Shuffle then stable sort by amount desc, as the module does.
    for (let i = bids.length - 1; i >= 1; i--) {
      const j = r.int(0, i);
      [bids[i], bids[j]] = [bids[j]!, bids[i]!];
    }
    bids.sort((x, y) => y.amount - x.amount);
    if (bids.length > 0) {
      const w = bids[0]!;
      const paid = auctionType === "FirstPrice" ? w.amount : bids[1] ? bids[1].amount : Math.min(1, w.amount);
      const p = players[w.i]!;
      p.balance -= paid;
      p.rack[c]++;
      tilesWon[w.i]!++;
      spent[w.i]! += paid;
      if (p.spec.kind === "sim") {
        // Module sims play their best word of 3+ when they win a tile.
        const best = bestPlayable(d, p.rack, 3);
        if (best) applyPlay(p, best.word, best.reward);
      }
    }
    // After each close, real bots may play (rack changed or endgame).
    // The last auction's close ends the match instantly: nobody plays.
    if (bagRemaining > 0) {
      for (const p of players) {
        if (p.spec.kind === "ours") oursPlay(p, bagRemaining);
        else if (p.spec.kind === "model") modelPlay(d, p, bagRemaining);
      }
    }
  }
  return {
    scores: players.map((p) => p.score),
    balances: players.map((p) => p.balance),
    words: players.map((p) => p.words),
    tilesWon,
    spent,
  };
}

export interface Summary {
  meanScore: number;
  meanRank: number;
  winRate: number;
  top2Rate: number;
  meanLeftover: number;
  meanTiles: number;
  meanSpent: number;
  oppMeanScore: number;
}

export function summarize(results: MatchResult[], ourIdx: number): Summary {
  let score = 0, rank = 0, wins = 0, top2 = 0, left = 0, tiles = 0, spent = 0, opp = 0, oppN = 0;
  for (const res of results) {
    const mine = res.scores[ourIdx]!;
    score += mine;
    const better = res.scores.filter((s, i) => i !== ourIdx && s > mine).length;
    const tied = res.scores.filter((s, i) => i !== ourIdx && s === mine).length;
    rank += 1 + better + tied / 2;
    if (better === 0) wins++;
    if (better <= 1) top2++;
    left += res.balances[ourIdx]!;
    tiles += res.tilesWon[ourIdx]!;
    spent += res.spent[ourIdx]!;
    res.scores.forEach((s, i) => {
      if (i !== ourIdx) {
        opp += s;
        oppN++;
      }
    });
  }
  const n = results.length;
  return {
    meanScore: score / n,
    meanRank: rank / n,
    winRate: wins / n,
    top2Rate: top2 / n,
    meanLeftover: left / n,
    meanTiles: tiles / n,
    meanSpent: spent / n,
    oppMeanScore: opp / oppN,
  };
}

// A field like the live lobby: strong real bots with varied pricing.
export function strongField(params: Params): OpponentKind[] {
  return [
    { kind: "ours", params },
    { kind: "model", name: "floor10", a: 9, b: 1.8, sigma: 2.5, skip: 0.1, completeBoost: 0.5 },
    { kind: "model", name: "premium", a: 7, b: 2.6, sigma: 3, skip: 0.1, completeBoost: 0.8 },
    { kind: "model", name: "flat", a: 11, b: 1.2, sigma: 2, skip: 0.15, completeBoost: 0.3 },
    { kind: "model", name: "hunter", a: 6, b: 2.0, sigma: 3, skip: 0.2, completeBoost: 1.2 },
    { kind: "model", name: "steady", a: 10, b: 1.5, sigma: 2, skip: 0.05, completeBoost: 0.6 },
  ];
}

export function mixedField(params: Params): OpponentKind[] {
  return [
    { kind: "ours", params },
    { kind: "model", name: "floor10", a: 9, b: 1.8, sigma: 2.5, skip: 0.1, completeBoost: 0.5 },
    { kind: "model", name: "premium", a: 7, b: 2.6, sigma: 3, skip: 0.1, completeBoost: 0.8 },
    { kind: "model", name: "hunter", a: 6, b: 2.0, sigma: 3, skip: 0.2, completeBoost: 1.2 },
    { kind: "sim", strategy: "Aggressive" },
    { kind: "sim", strategy: "ValueBidder" },
  ];
}

export function runMany(d: Dictionary, field: OpponentKind[], n: number, seed: number, auctionType: "Vickrey" | "FirstPrice" = "Vickrey"): MatchResult[] {
  const r = rng(seed);
  const out: MatchResult[] = [];
  for (let i = 0; i < n; i++) out.push(runMatch(d, field, r, auctionType));
  return out;
}

export function fmt(s: Summary): string {
  return `score=${s.meanScore.toFixed(1)} rank=${s.meanRank.toFixed(2)} win=${(s.winRate * 100).toFixed(0)}% top2=${(s.top2Rate * 100).toFixed(0)}% left=${s.meanLeftover.toFixed(1)} tiles=${s.meanTiles.toFixed(1)} spent=${s.meanSpent.toFixed(0)} opp=${s.oppMeanScore.toFixed(1)}`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("sim.ts");
if (isMain) {
  const n = Number(process.argv[2] ?? 200);
  const seed = Number(process.argv[3] ?? 1);
  const d = loadDictionary(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "wordlist.txt"));
  const t0 = performance.now();
  const strong = runMany(d, strongField(DEFAULT_PARAMS), n, seed);
  const t1 = performance.now();
  console.log(`strong field (${n} matches, ${((t1 - t0) / 1000).toFixed(1)}s): ${fmt(summarize(strong, 0))}`);
  const mixed = runMany(d, mixedField(DEFAULT_PARAMS), n, seed);
  console.log(`mixed field : ${fmt(summarize(mixed, 0))}`);
  // Show a sample match.
  const sample = strong[0]!;
  sample.scores.forEach((s, i) => console.log(`  p${i} score=${s} bal=${sample.balances[i]} tiles=${sample.tilesWon[i]} spent=${sample.spent[i]} words=${sample.words[i]!.join(",")}`));
}
