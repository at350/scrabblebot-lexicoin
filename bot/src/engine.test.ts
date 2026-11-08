// Run with: npm test
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  bestCashOut,
  bestPlayable,
  greedyCashOut,
  loadDictionary,
  nearWords,
  playableWords,
  rackFromString,
  wordReward,
} from "./engine.js";
import { DEFAULT_PARAMS, decideBid, decidePlays, type MatchView } from "./strategy.js";
import { BAG_COUNTS, emptyRack } from "./engine.js";

const d = loadDictionary(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "wordlist.txt"));

test("rewards follow the module's multipliers", () => {
  assert.equal(wordReward("CAT"), 5);
  assert.equal(wordReward("TACT"), Math.floor((6 * 3) / 2));
  assert.equal(wordReward("QUAILED"), 51);
  assert.equal(wordReward("MARQUEE"), 54);
});

test("playable words respect letter counts", () => {
  const ps = playableWords(d, rackFromString("TACT")).map((p) => p.word);
  assert.ok(ps.includes("TACT"));
  assert.ok(ps.includes("CAT"));
  assert.ok(!ps.includes("TATTS"));
  assert.equal(bestPlayable(d, rackFromString("CX")), null);
});

test("near words report the missing tiles", () => {
  const nw = nearWords(d, rackFromString("VAQERO"), 1, 7, 7).find((w) => w.word === "VAQUERO");
  assert.ok(nw);
  assert.deepEqual(nw!.missing, ["U".charCodeAt(0) - 65]);
});

test("cash-out search is at least as good as greedy", () => {
  for (const r of ["AEIOURSTLNDG", "QUIZJAXKBCDE", "EEEEAAIIOONN"]) {
    const rack = rackFromString(r);
    const g = greedyCashOut(d, rack).reduce((s, w) => s + w.reward, 0);
    const b = bestCashOut(d, rack).reduce((s, w) => s + w.reward, 0);
    assert.ok(b >= g, `${r}: ${b} < ${g}`);
  }
});

function view(rack: string, balance: number, bagRemaining: number): MatchView {
  const pool = new Int32Array(BAG_COUNTS);
  for (const c of rack) pool[c.charCodeAt(0) - 65]--;
  return { rack: rackFromString(rack), balance, score: 0, bagRemaining, pool, auctionType: "Vickrey", opponents: [{ balance: 80, score: 20 }, { balance: 60, score: 40 }] };
}

test("never bids on the last tile, bids whole balance to complete a word on the penultimate one", () => {
  assert.equal(decideBid(d, "E", view("ABC", 50, 0), DEFAULT_PARAMS).amount, 0);
  const pen = decideBid(d, "U", view("VAQERO", 37, 1), DEFAULT_PARAMS);
  assert.equal(pen.amount, 37);
  assert.equal(decideBid(d, "Z", view("", 37, 1), DEFAULT_PARAMS).amount, 0);
});

test("a tile completing a big word is bid above market", () => {
  const b = decideBid(d, "U", view("VAQERO", 60, 30), DEFAULT_PARAMS);
  assert.ok(b.amount >= 25, `bid ${b.amount}`);
});

test("decisions are fast enough for a one-second auction", () => {
  const v = view("ABCDEFGHIJKLMN", 80, 40);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) decideBid(d, "E", v, DEFAULT_PARAMS);
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 250, `decideBid took ${ms.toFixed(1)}ms`);
});

test("endgame dumps the rack", () => {
  const plays = decidePlays(d, view("CATSDOG", 10, 1), DEFAULT_PARAMS);
  assert.ok(plays.length >= 1);
  const e = emptyRack();
  assert.equal(e.length, 26);
});
