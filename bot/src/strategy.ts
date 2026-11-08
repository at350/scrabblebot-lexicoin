// Bidding and word-play strategy. Pure: takes a view of the match and
// returns decisions, so the simulator can drive it exactly like the live bot.
//
// The economics: score counts word rewards only, coins left at the end are
// worthless, and every tile costs roughly a 10-coin market floor plus a
// premium for letter value. So the game is to spend the whole budget on the
// tiles that most efficiently complete long (7+, 3x) words. A tile's value
// is how much it advances the best "plan": the near-complete long word with
// the highest reward net of the market cost of the tiles it still needs.

import {
  BAG_COUNTS,
  LETTER_VALUE,
  bestCashOut,
  bestPlayable,
  greedyCashOut,
  nearWords,
  playableWords,
  rackAdd,
  rackRemoveWord,
  rackTotal,
  type Dictionary,
  type Playable,
  type Rack,
} from "./engine.js";

export interface Opponent {
  balance: number;
  score: number;
}

export interface MatchView {
  rack: Rack;
  balance: number;
  score: number;
  // Tiles still in the bag. The current open auction's tile is not in it,
  // so this is also the number of auctions after the current one.
  bagRemaining: number;
  // Tiles whose location we don't know: not in our rack history and not yet
  // auctioned. Of these, `bagRemaining` are in the bag and the rest sit in
  // opponents' racks.
  pool: Rack;
  auctionType: "Vickrey" | "FirstPrice";
  opponents: Opponent[];
  // Observed market price per letter value (index = letter value 1..10),
  // if the caller has data; otherwise the default model is used.
  priceByValue?: (number | undefined)[];
}

export interface Params {
  maxMissing: number; // how far from complete a word may be to count
  minTargetLen: number; // we build toward words at least this long
  maxTargetLen: number;
  winProb: number; // chance we win a tile we go after
  optionBonus: number; // value of having many near-complete options
  priceA: number; // market model: second price paid = priceA + priceB * letterValue
  priceB: number;
  winA: number; // bid needed to win = winA + winB * letterValue (top bids run higher than prices paid)
  winB: number;
  heavyCpp: number; // efficiency floor: bid at least 3 * letterValue * heavyCpp for heavy letters
  autoPlayMinReward: number; // cash a 7+ word only if it pays at least this (or the rack is bloated)
  autoPlayRack: number; // ...or the rack has at least this many tiles
  // Money management.
  scaleLow: number;
  scaleHigh: number;
  shareOfTiles: number; // fraction of remaining tiles we expect to take
  spendDownFrom: number; // remaining auctions at which spend-down starts
  // Play policy.
  autoPlayMinLen: number;
  lowBalance: number;
  lowBalanceMinReward: number;
  endgameDump: number; // bagRemaining at or below which we cash everything
  maxRackHold: number; // rack size above which we cash the best word
  // First-price shading.
  firstPriceShade: number;
  // Coins one point of expected reward is worth when bidding. Coins left at
  // the end are worthless, so this is the match's exchange rate.
  coinsPerPoint: number;
  // Generic building bid (when the rack is too small to have a plan):
  // market price times letter fit times this weight.
  genericWeight: number;
  genericFadeFrom: number; // rack size where the generic bid starts fading
  efficiencyWeight: number; // extra for letters whose 3x value beats their price
  genericMinBalance: number; // below this balance, speculative bids shrink
  // Pacing against the field: bids scale by (our balance / mean opponent
  // balance) ^ relMoneyPow, so spending ahead of the field slows us down.
  relMoneyPow: number;
  // Immediate short plays (under the target length) count at this weight:
  // they are a fallback, not the goal, so a tile that only makes a 4-letter
  // word shouldn't be bid for like one that completes a 7.
  shortPlayWeight: number;
  // Selective allocation: rank letters by desirability (plan gain plus a
  // letter prior) against the pool of tiles still to come, and bid
  // decisively (above the winning level) only on the top fraction we can
  // afford to buy; fish with token bids elsewhere.
  selective: boolean;
  decisiveMult: number; // decisive bid = winPrice * this (at least)
  fishMult: number; // token bid = desirability * coinsPerPoint * this
  intrinsicW: number; // letter prior per point of letter value
  affordScale: number; // how many tiles we plan to buy = balance / avgPaidPrice * this
  fishFloor: number; // token bid on any useful letter, to pick up cheap tiles when rivals are broke
  buildW: number; // desirability from letter fit while the rack is too small to have a plan
  // Weight of the tiles left over after the best plan, valued as a plan of
  // their own (one level deep). Lets a big rack be worth two words.
  secondPlanW: number;
  // Spend pacing: cumulative spend is compared with a linear schedule over
  // the match (top bots spend ~186 coins at 2-4 tiles per 20 auctions).
  // Ahead of schedule -> buy less; behind -> widen the target.
  paceSlack: number; // coins of overspend tolerated before bids shrink
  paceGain: number; // coins behind/ahead per unit of adjustment
  paceTotal: number; // coins a strong bot spends over a whole match
  paceCurve: number; // exponent on elapsed fraction: >1 spends slowly early, fast late
  minFraction: number; // never target fewer than this share of remaining tiles
  // Cash threshold for long words early vs late (top bots hold 30-47 point
  // words early for an upgrade, then take what they have).
  autoPlayMinRewardLate: number;
  lateFromRemaining: number; // auctions remaining at which the late threshold applies
  // Hold a playable long word when one more tile would upgrade it by this
  // ratio with at least this probability (e.g. MEDIATIVE 45 -> ITEMIZED 60).
  holdRatio: number;
  holdFeas: number;
  holdMinBag: number;
  // Completion reserve: while one tile away from a word worth at least
  // this, keep enough coins to win that tile.
  reserveMinReward: number;
  // Live only: when the rack just changed, bid with the previous letter
  // ranking and refresh it afterwards (see refreshDistribution), instead of
  // spending hundreds of milliseconds inside the auction window.
  allowStaleDistribution: boolean;
  // Plan reward bias: words worth more than 35 count for more, cheap long
  // words for less, so building aims at DRIVEWAY-class words.
  rewardBias: number;
}

export const DEFAULT_PARAMS: Params = {
  maxMissing: 3,
  minTargetLen: 7,
  maxTargetLen: 9,
  winProb: 0.7,
  optionBonus: 3.0,
  // Second price paid, from 30 live matches among top bots: v1 ~11, v3 ~16,
  // v4 ~18.5, K ~22, J/X ~25, Z ~33.
  priceA: 9.5,
  priceB: 1.7,
  // 75th-percentile winning bid: v1 ~18, v3 ~23, v4 ~25, K ~31, J/X ~37,
  // Q ~32, Z ~50. Bidding here wins ~75% of auctions at the second price.
  winA: 15.5,
  winB: 2.5,
  heavyCpp: 1.8,
  autoPlayMinReward: 42,
  autoPlayRack: 11,
  scaleLow: 0.8,
  scaleHigh: 2.0,
  shareOfTiles: 0.18,
  spendDownFrom: 10,
  autoPlayMinLen: 7,
  lowBalance: 12,
  lowBalanceMinReward: 20,
  endgameDump: 1,
  maxRackHold: 14,
  firstPriceShade: 0.65,
  coinsPerPoint: 2.0,
  genericWeight: 1.0,
  genericFadeFrom: 7,
  efficiencyWeight: 1.2,
  genericMinBalance: 30,
  relMoneyPow: 0.75,
  shortPlayWeight: 0.7,
  selective: true,
  decisiveMult: 1.0,
  fishMult: 0.5,
  intrinsicW: 1.0,
  affordScale: 1.3,
  fishFloor: 9,
  buildW: 5,
  secondPlanW: 0.5,
  paceSlack: 12,
  paceGain: 30,
  paceTotal: 180,
  paceCurve: 1.0,
  minFraction: 0.12,
  autoPlayMinRewardLate: 36,
  lateFromRemaining: 24,
  holdRatio: 1.2,
  holdFeas: 0.35,
  holdMinBag: 12,
  reserveMinReward: 33,
  allowStaleDistribution: false,
  rewardBias: 0.03,
};

export function marketPrice(view: MatchView, p: Params, c: number): number {
  const v = LETTER_VALUE[c]!;
  const obs = view.priceByValue?.[v];
  const model = p.priceA + p.priceB * v;
  return obs !== undefined ? 0.5 * obs + 0.5 * model : model;
}

export function winPrice(view: MatchView, p: Params, c: number): number {
  const v = LETTER_VALUE[c]!;
  const obs = view.priceByValue?.[v];
  const model = p.winA + p.winB * v;
  // Observed second prices run below winning bids; lift them by the same margin.
  return obs !== undefined ? 0.5 * (obs + (p.winA - p.priceA) + (p.winB - p.priceB) * v) + 0.5 * model : model;
}

// Probability that at least one tile of letter `c` still comes up for
// auction, given how many of them are unaccounted for and how many of the
// unaccounted tiles are actually in the bag.
function pAppears(pool: Rack, bagRemaining: number, c: number, alreadyNeeded: number): number {
  const n = (pool[c] ?? 0) - alreadyNeeded;
  if (n <= 0 || bagRemaining <= 0) return 0;
  const size = rackTotal(pool);
  if (size <= 0) return 0;
  const q = Math.min(1, bagRemaining / size);
  return 1 - Math.pow(1 - q, n);
}

export interface Plan {
  word: string;
  reward: number;
  missing: number[];
  feasibility: number;
  net: number;
}

// Value of the rack: the best plan's expected net reward, plus a bonus for
// having many plans. Immediate plays count as plans with nothing missing.
export function evaluateRack(d: Dictionary, rack: Rack, view: MatchView, p: Params, depth = 1): { value: number; best: Plan | null } {
  const immediate = bestPlayable(d, rack, 2);
  const immWeight = immediate && immediate.len < p.minTargetLen && view.bagRemaining > p.spendDownFrom ? p.shortPlayWeight : 1;
  let best: Plan | null = immediate
    ? { word: immediate.word, reward: immediate.reward, missing: [], feasibility: 1, net: immediate.reward * immWeight }
    : null;
  let bestValue = best?.net ?? 0;
  if (view.bagRemaining <= 0) return { value: bestValue, best };

  let optionMass = 0;
  const total = rackTotal(rack);
  // Only tiles drawn before the last auction can still be played.
  const horizon = Math.max(0, view.bagRemaining - 1);
  const maxLen = Math.min(p.maxTargetLen, total + Math.min(p.maxMissing, horizon));
  const need = new Int32Array(26);
  for (const nw of nearWords(d, rack, Math.min(p.maxMissing, horizon), p.minTargetLen, maxLen)) {
    const k = nw.missing.length;
    if (k > horizon) continue;
    let feas = 1;
    let cost = 0;
    if (k > 0) {
      need.fill(0);
      for (const c of nw.missing) {
        feas *= pAppears(view.pool, horizon, c, need[c]!) * p.winProb;
        need[c]!++;
        cost += marketPrice(view, p, c);
      }
    }
    // Net of the coins the missing tiles will cost (at the match's
    // points-per-coin exchange rate); coins have no value at the end, but
    // spending them here means not spending them elsewhere.
    const biased = nw.reward * (1 + p.rewardBias * (nw.reward - 35));
    const net = feas * (biased - cost / p.coinsPerPoint);
    if (net > bestValue) {
      bestValue = net;
      best = { word: nw.word, reward: nw.reward, missing: nw.missing, feasibility: feas, net };
    }
    if (net > 0) optionMass += net;
  }
  let value = bestValue + p.optionBonus * Math.log1p(optionMass / 20);
  // What the rest of the rack is worth once the best word is gone.
  if (depth > 0 && p.secondPlanW > 0 && best && best.word.length >= p.minTargetLen) {
    const leftover = new Int32Array(rack);
    for (let i = 0; i < best.word.length; i++) {
      const c = best.word.charCodeAt(i) - 65;
      if (leftover[c]! > 0) leftover[c]--;
    }
    if (rackTotal(leftover) >= 2) {
      const sub = evaluateRack(d, leftover, view, p, depth - 1);
      value += p.secondPlanW * sub.value;
    }
  }
  return { value, best };
}

const VOWEL_MASK = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 14) | (1 << 20);

// How well a letter fits a rack that is still being built toward a long
// word: versatility, duplicates, vowel balance and point efficiency.
export function letterFit(d: Dictionary, rack: Rack, c: number, view: MatchView, p: Params): number {
  const have = rack[c]!;
  const dup = have === 0 ? 1 : have === 1 ? (d.containFrac[c]! > 0.3 ? 0.85 : 0.6) : have === 2 ? 0.35 : 0.1;
  let vowels = 0;
  let total = 0;
  for (let i = 0; i < 26; i++) {
    total += rack[i]!;
    if (VOWEL_MASK & (1 << i)) vowels += rack[i]!;
  }
  const isVowel = (VOWEL_MASK & (1 << c)) !== 0;
  const ratioAfter = (vowels + (isVowel ? 1 : 0)) / (total + 1);
  const balance = Math.max(0.5, 1 - 1.5 * Math.abs(ratioAfter - 0.42));
  // Versatility: E/S/A/R/I ~ 0.45-0.65, Q/Z/J/X ~ 0.02-0.04.
  const vers = 0.75 + 0.9 * Math.sqrt(d.containFrac[c]!);
  const price = winPrice(view, p, c);
  // Points per coin in a long word, capped so the rare heavy tiles don't
  // dominate the building phase (plans handle those once the rack can
  // carry them); 3-4 point consonants land level with the best vowels.
  const efficiency = Math.min(0.5, (3 * LETTER_VALUE[c]!) / Math.max(1, price));
  return dup * balance * vers * (1 + p.efficiencyWeight * (efficiency - 0.35));
}

export function moneyScale(view: MatchView, p: Params): number {
  const remaining = view.bagRemaining + 1;
  const avgPrice = p.priceA + p.priceB * 1.9; // bag-weighted mean letter value ~1.9
  const affordable = view.balance / avgPrice;
  const share = remaining * p.shareOfTiles;
  const pressure = affordable / Math.max(1, share);
  const t = Math.max(0, Math.min(1, pressure / 2));
  let scale = p.scaleLow + (p.scaleHigh - p.scaleLow) * t;
  if (p.relMoneyPow > 0 && remaining > p.spendDownFrom) {
    // Pace against opponents that are actually playing; idle bots sitting
    // on their 100 coins would otherwise make everyone look poor.
    const active = view.opponents.filter((o) => o.balance !== 100 || o.score > 0).map((o) => Math.max(0, o.balance)).sort((a, b) => a - b);
    if (active.length >= 2) {
      const median = active[Math.floor(active.length / 2)]!;
      const rel = (view.balance + 10) / (median + 10);
      scale *= Math.pow(Math.max(0.6, Math.min(1.5, rel)), p.relMoneyPow);
    }
  }
  return scale;
}

export interface BidDecision {
  amount: number;
  marginal: number;
  reason: string;
}

export function decideBid(d: Dictionary, letter: string, view: MatchView, p: Params): BidDecision {
  const c = letter.charCodeAt(0) - 65;
  if (c < 0 || c > 25) return { amount: 0, marginal: 0, reason: "bad letter" };
  if (view.balance <= 0) return { amount: 0, marginal: 0, reason: "broke" };

  // The last tile can never be played: the match ends the moment its
  // auction closes.
  if (view.bagRemaining <= 0) return { amount: 0, marginal: 0, reason: "last tile" };

  const withL = rackAdd(view.rack, c);

  // Second-to-last tile: we get one second to play it, so only its
  // immediate value counts, and money is worthless afterwards.
  if (view.bagRemaining === 1) {
    const imm0 = bestCashOut(d, view.rack, 8, 2).reduce((s, w) => s + w.reward, 0);
    const imm1 = bestCashOut(d, withL, 8, 2).reduce((s, w) => s + w.reward, 0);
    const marginal = Math.max(0, imm1 - imm0);
    const amount = marginal > 0 ? view.balance : 0;
    return { amount, marginal, reason: "penultimate" };
  }

  const before = evaluateRack(d, view.rack, view, p);
  const after = evaluateRack(d, withL, view, p);
  const marginal = Math.max(0, after.value - before.value);

  const scale = moneyScale(view, p);
  let amount = marginal * p.coinsPerPoint * scale;

  if (p.selective) return decideSelective(d, c, view, p, before.value, marginal, after.best, before.best);

  // Building bid: with few tiles there is no concrete plan yet, but every
  // long word needs seven tiles, so buy well-fitting ones at market.
  const total = rackTotal(view.rack);
  const fade = total <= p.genericFadeFrom ? 1 : Math.max(0, 1 - (total - p.genericFadeFrom) / 5);
  const remaining = view.bagRemaining + 1;
  if (fade > 0) {
    // Don't gamble the last coins on tiles that fit no plan: keep them for
    // the tile that completes one. (Not near the end, when coins expire.)
    const reserve = remaining <= p.spendDownFrom ? 1 : Math.min(1, view.balance / p.genericMinBalance);
    const fit = letterFit(d, view.rack, c, view, p);
    const generic = winPrice(view, p, c) * fit * p.genericWeight * fade * scale * reserve;
    if (generic > amount) amount = generic;
    // Heavy letters pay 3x their value in any long word, which beats their
    // price; don't let a low fit score talk us out of them.
    const heavy = 3 * LETTER_VALUE[c]! * p.heavyCpp * Math.min(1, fit + 0.5) * scale * reserve;
    if (LETTER_VALUE[c]! >= 4 && heavy > amount) amount = heavy;
  }

  // Near the end, leftover coins are worthless: spend down on anything
  // that could still end up in a word. Only auctions whose tile can still
  // be played count: the last one can't, the one before only immediately.
  if (remaining <= p.spendDownFrom && amount > 0) {
    const usefulLeft = Math.max(1, Math.min(remaining - 1, 3));
    const spendDown = view.balance / usefulLeft;
    if (spendDown > amount) amount = spendDown;
  }

  if (view.auctionType === "FirstPrice") amount *= p.firstPriceShade;

  amount = Math.floor(amount);
  if (amount > view.balance) amount = view.balance;
  if (amount < 0) amount = 0;
  return {
    amount,
    marginal,
    reason: `m=${marginal.toFixed(1)} s=${scale.toFixed(2)} plan=${after.best?.word ?? "-"}(${after.best?.missing.length ?? 0})`,
  };
}

// ---------- Selective allocation ----------

// Desirability distribution over the tiles still to come, cached per rack
// (it only changes when the rack does; the bag shrinking barely moves it).
let distCacheKey = "";
let distCache: { values: number[]; weights: number[] } = { values: [], weights: [] };
// Pending refresh, computed one letter per call so the event loop stays
// responsive (a full 26-letter pass can take hundreds of milliseconds on a
// loaded machine, and auction notifications must not queue behind it).
let distPending: { step: () => boolean } | null = null;

// Live bot: call repeatedly (e.g. via setImmediate) after bidding. Returns
// true while more work remains.
export function refreshDistribution(): boolean {
  if (!distPending) return false;
  const more = distPending.step();
  if (!more) distPending = null;
  return more;
}

function distKey(view: MatchView, intrinsicW: number, fade: number): string {
  return `${rackToKey(view.rack)}|${Math.floor(view.bagRemaining / 6)}|${intrinsicW.toFixed(2)}|${fade.toFixed(2)}`;
}

function computeDistribution(d: Dictionary, view: MatchView, p: Params, baseValue: number, intrinsicW: number, fade: number, key: string) {
  const values: number[] = [];
  const weights: number[] = [];
  for (let c = 0; c < 26; c++) {
    const n = view.pool[c] ?? 0;
    if (n <= 0) continue;
    values.push(desirability(d, c, view, p, baseValue, intrinsicW, fade));
    weights.push(n);
  }
  distCacheKey = key;
  distCache = { values, weights };
}

// With fewer tiles than a long word minus the allowed missing count, no
// plan exists yet. Then letters are ranked by how well they build toward
// one (fit: vowel balance, versatility, efficiency), not by face value: a
// word needs seven tiles, and heavy letters alone never make one.
function buildFade(view: MatchView, p: Params): number {
  const total = rackTotal(view.rack);
  const full = p.minTargetLen - p.maxMissing; // rack size at which plans appear
  return total <= full ? 1 : Math.max(0, 1 - (total - full) / 4);
}

function letterPrior(d: Dictionary, c: number, view: MatchView, p: Params, fade: number): number {
  const build = fade > 0 ? p.buildW * fade * letterFit(d, view.rack, c, view, p) : 0;
  return LETTER_VALUE[c]! * (1 - fade) + build;
}

// The distribution over 26 letters is the expensive part of a decision, so
// it uses the shallow valuation; the auctioned letter itself gets the full
// one. The threshold it sets is only a ranking cut, so the approximation
// costs little.
function desirability(d: Dictionary, c: number, view: MatchView, p: Params, baseValue: number, intrinsicW: number, fade: number): number {
  const after = evaluateRack(d, rackAdd(view.rack, c), view, p, 0).value;
  return Math.max(0, after - baseValue) + intrinsicW * letterPrior(d, c, view, p, fade);
}

function desirabilityThreshold(d: Dictionary, view: MatchView, p: Params, baseValue: number, fraction: number, intrinsicW: number, fade: number): number {
  const key = distKey(view, intrinsicW, fade);
  if (key !== distCacheKey) {
    // Snapshot the view: the caller's rack array may be reused.
    const snap: MatchView = { ...view, rack: new Int32Array(view.rack), pool: new Int32Array(view.pool) };
    if (p.allowStaleDistribution && distCache.values.length > 0) {
      const values: number[] = [];
      const weights: number[] = [];
      let c = 0;
      distPending = {
        step: () => {
          while (c < 26 && (snap.pool[c] ?? 0) <= 0) c++;
          if (c < 26) {
            values.push(desirability(d, c, snap, p, baseValue, intrinsicW, fade));
            weights.push(snap.pool[c]!);
            c++;
          }
          if (c >= 26) {
            distCacheKey = key;
            distCache = { values, weights };
            return false;
          }
          return true;
        },
      };
    } else {
      computeDistribution(d, snap, p, baseValue, intrinsicW, fade, key);
    }
  }
  const { values, weights } = distCache;
  if (values.length === 0) return 0;
  const order = values.map((v, i) => i).sort((a, b) => values[b]! - values[a]!);
  const totalW = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const i of order) {
    acc += weights[i]!;
    if (acc >= fraction * totalW) return values[i]!;
  }
  return values[order[order.length - 1]!]!;
}

function rackToKey(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++) if (r[i]! > 0) s += String.fromCharCode(65 + i) + r[i];
  return s;
}

function decideSelective(d: Dictionary, c: number, view: MatchView, p: Params, baseValue: number, marginal: number, plan: Plan | null, current: Plan | null): BidDecision {
  const remaining = view.bagRemaining + 1;
  // We pay the second price, not our bid: budget tiles at the paid level.
  const avgPaid = p.priceA + p.priceB * 1.9;
  // How many of the remaining tiles we can afford, as a fraction of what's
  // left (excluding the unplayable last one).
  // Pace: planned spend so far is a linear share of everything we've had.
  const total68 = 68;
  const elapsed = Math.max(0, Math.min(1, (total68 - remaining) / total68));
  const hadInAll = 100 + view.score;
  const planned = Math.max(hadInAll, p.paceTotal) * Math.pow(elapsed, p.paceCurve);
  const spent = hadInAll - view.balance;
  const behind = planned - spent; // > 0: under-spending
  const paceAdj = remaining > p.spendDownFrom ? Math.max(0.55, Math.min(1.6, 1 + (behind + p.paceSlack) / p.paceGain)) : 1;
  const affordable = (view.balance / avgPaid) * p.affordScale * paceAdj;
  // The letter prior (a heavy tile is worth 3x its value in some future
  // word) only matters while we can still afford to build; when the purse
  // is down to a tile or two, only completing a plan counts.
  const intrinsicW = p.intrinsicW * Math.min(1, affordable / 4);
  const fade = buildFade(view, p);
  const des = marginal + intrinsicW * letterPrior(d, c, view, p, fade);
  const fraction = Math.max(p.minFraction, Math.min(0.95, affordable / Math.max(1, remaining - 1)));
  const threshold = desirabilityThreshold(d, view, p, baseValue, fraction, intrinsicW, fade);
  const scale = moneyScale(view, p);
  const win = winPrice(view, p, c);
  let amount: number;
  let mode: string;
  // Does this tile complete a long word right now? Then its value is
  // concrete and worth paying for; otherwise it is one step of a plan and
  // must fit the budget: never more than a third of the purse on one tile.
  let usesTile = 0;
  if (plan) for (let i = 0; i < plan.word.length; i++) if (plan.word.charCodeAt(i) - 65 === c) usesTile++;
  const completes = plan !== null && plan.missing.length === 0 && plan.word.length >= p.minTargetLen && usesTile > view.rack[c]!;
  if (des >= threshold && des > 0) {
    amount = win * p.decisiveMult * Math.max(0.8, Math.min(1.1, scale));
    if (completes) amount = Math.max(amount, des * p.coinsPerPoint);
    else if (remaining > p.spendDownFrom) {
      // Never more than a third of the purse on one speculative tile, but
      // a small purse must still be able to win an ordinary letter.
      const cap = Math.max(view.balance / 3, Math.min(view.balance, p.winA + p.winB)) * Math.min(1, paceAdj);
      amount = Math.min(amount, cap);
    }
    mode = completes ? "GO!" : "GO";
  } else {
    amount = des * p.coinsPerPoint * p.fishMult * scale;
    // Rivals run out of coins mid-match and tiles go for 5-9; a token bid
    // on any letter we could use picks those up.
    if (des > 1.5 && view.balance >= p.genericMinBalance && amount < p.fishFloor) amount = p.fishFloor;
    mode = "fish";
  }
  // Heavy letters pay 3x their value in any long word; never let them go
  // for less than that when we can afford it.
  // ...but only while we can still afford the filler around them, and not
  // when the rack already holds unplayed heavy tiles: Q+X+Z together is a
  // dead rack, not a plan.
  let heavyHeld = 0;
  let vowelsHeld = 0;
  for (let i = 0; i < 26; i++) {
    if (LETTER_VALUE[i]! >= 5) heavyHeld += view.rack[i]!;
    if (VOWEL_MASK & (1 << i)) vowelsHeld += view.rack[i]!;
  }
  // A second heavy tile is fine when the rack has the vowels to carry it
  // (EQUINOX, MITZVAH); a third is a dead rack.
  const heavyOk = heavyHeld === 0 || (heavyHeld === 1 && vowelsHeld >= 2) || (heavyHeld === 2 && vowelsHeld >= 3 && LETTER_VALUE[c]! <= 5);
  if (LETTER_VALUE[c]! >= 5 && remaining > p.spendDownFrom && affordable >= 3 && heavyOk && des >= threshold * 0.5) {
    const heavy = 3 * LETTER_VALUE[c]! * p.heavyCpp * Math.min(1, affordable / 7);
    if (heavy > amount) {
      amount = heavy;
      mode = "heavy";
    }
  }
  // Budget cap applies to every speculative bid, floors included: heavy
  // tiles may take a bit more of the purse, but never most of it.
  if (!completes && remaining > p.spendDownFrom) {
    // Letters worth 3+ are the efficient buys (9-30 points each in a long
    // word); they may take a larger slice of the purse than filler.
    const v = LETTER_VALUE[c]!;
    const share = v >= 8 ? 1.8 : v >= 3 ? 2.2 : 3;
    const cap = Math.max(view.balance / share, Math.min(view.balance, p.winA + p.winB)) * Math.min(1, paceAdj);
    if (amount > cap) amount = cap;
  }
  // Completion reserve: one tile from a good word, keep the coins to buy
  // that tile; filler can wait.
  if (!completes && remaining > p.spendDownFrom && current && current.missing.length === 1 && current.reward >= p.reserveMinReward) {
    const need = current.missing[0]!;
    if (need !== c) {
      const reserve = Math.min(view.balance, winPrice(view, p, need));
      const spendable = Math.max(0, view.balance - reserve);
      if (amount > spendable) {
        amount = spendable;
        mode += "+rsv";
      }
    }
  }
  if (remaining <= p.spendDownFrom && amount > 0) {
    const usefulLeft = Math.max(1, Math.min(remaining - 1, 3));
    const spendDown = view.balance / usefulLeft;
    if (spendDown > amount) amount = spendDown;
  }
  if (view.auctionType === "FirstPrice") amount *= p.firstPriceShade;
  amount = Math.floor(amount);
  if (amount > view.balance) amount = view.balance;
  if (amount < 0) amount = 0;
  return {
    amount,
    marginal,
    reason: `${mode} d=${des.toFixed(1)} thr=${threshold.toFixed(1)} f=${fraction.toFixed(2)} pace=${paceAdj.toFixed(2)} s=${scale.toFixed(2)} plan=${plan?.word ?? "-"}(${plan?.missing.length ?? 0})`,
  };
}

// Which words to play now, in order. The rack passed in is the live rack.
export function decidePlays(d: Dictionary, view: MatchView, p: Params): Playable[] {
  const rack = view.rack;
  const total = rackTotal(rack);
  if (total < 2) return [];

  // Endgame: cash everything, best combination first.
  if (view.bagRemaining <= p.endgameDump) {
    return bestCashOut(d, rack, 12, 2);
  }

  const plays: Playable[] = [];
  let r = rack;
  // Cash long words once they pay well: the multiplier is maxed and the
  // coins fund more tiles. A cheap 7-letter word (all 1-point tiles) is
  // held instead, since the same tiles can grow into something better.
  for (;;) {
    const best = bestPlayable(d, r, p.autoPlayMinLen);
    if (!best) break;
    const bloated = rackTotal(r) >= p.autoPlayRack;
    const minReward = view.bagRemaining + 1 <= p.lateFromRemaining ? p.autoPlayMinRewardLate : p.autoPlayMinReward;
    if (best.reward < minReward && !bloated && view.balance >= p.lowBalance) break;
    // Worth waiting one tile for a much better word?
    if (plays.length === 0 && !bloated && view.balance >= p.lowBalance && view.bagRemaining >= p.holdMinBag) {
      let upgrade = 0;
      for (const nw of nearWords(d, r, 1, p.minTargetLen, rackTotal(r) + 1)) {
        if (nw.missing.length !== 1 || nw.reward < best.reward * p.holdRatio) continue;
        const c = nw.missing[0]!;
        const feas = pAppears(view.pool, Math.max(0, view.bagRemaining - 1), c, 0) * p.winProb;
        if (feas >= p.holdFeas && winPrice(view, p, c) <= view.balance && nw.reward > upgrade) upgrade = nw.reward;
      }
      if (upgrade > 0) break;
    }
    plays.push(best);
    r = rackRemoveWord(r, best.word);
  }
  if (plays.length > 0) return plays;

  // Low on cash: sell a decent word to keep bidding.
  if (view.balance < p.lowBalance) {
    const best = bestPlayable(d, r, 4);
    if (best && best.reward >= p.lowBalanceMinReward) return [best];
  }

  // Rack bloat: too many tiles to ever use; cash the best word.
  if (total > p.maxRackHold) {
    const best = bestPlayable(d, r, 4);
    if (best) return [best];
  }
  return [];
}

// Convenience for the live bot and tests.
export function playableSummary(d: Dictionary, rack: Rack): string {
  const ps = playableWords(d, rack, 2).sort((a, b) => b.reward - a.reward).slice(0, 5);
  return ps.map((x) => `${x.word}:${x.reward}`).join(" ");
}

export { BAG_COUNTS };
