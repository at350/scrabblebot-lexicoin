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
}

export const DEFAULT_PARAMS: Params = {
  maxMissing: 3,
  minTargetLen: 7,
  maxTargetLen: 9,
  winProb: 0.7,
  optionBonus: 3.0,
  priceA: 9,
  priceB: 1.8,
  winA: 11,
  winB: 2.3,
  heavyCpp: 1.2,
  autoPlayMinReward: 30,
  autoPlayRack: 11,
  scaleLow: 0.8,
  scaleHigh: 2.0,
  shareOfTiles: 0.18,
  spendDownFrom: 8,
  autoPlayMinLen: 7,
  lowBalance: 12,
  lowBalanceMinReward: 20,
  endgameDump: 1,
  maxRackHold: 14,
  firstPriceShade: 0.65,
  coinsPerPoint: 2.0,
  genericWeight: 1.0,
  genericFadeFrom: 7,
  efficiencyWeight: 0.4,
  genericMinBalance: 30,
  relMoneyPow: 1.0,
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
export function evaluateRack(d: Dictionary, rack: Rack, view: MatchView, p: Params): { value: number; best: Plan | null } {
  const immediate = bestPlayable(d, rack, 2);
  let best: Plan | null = immediate
    ? { word: immediate.word, reward: immediate.reward, missing: [], feasibility: 1, net: immediate.reward }
    : null;
  let bestValue = best?.net ?? 0;
  if (view.bagRemaining <= 0) return { value: bestValue, best };

  let optionMass = 0;
  const total = rackTotal(rack);
  const maxLen = Math.min(p.maxTargetLen, total + p.maxMissing);
  const need = new Int32Array(26);
  for (const nw of nearWords(d, rack, p.maxMissing, p.minTargetLen, maxLen)) {
    const k = nw.missing.length;
    let feas = 1;
    let cost = 0;
    if (k > 0) {
      need.fill(0);
      for (const c of nw.missing) {
        feas *= pAppears(view.pool, view.bagRemaining, c, need[c]!) * p.winProb;
        need[c]!++;
        cost += marketPrice(view, p, c);
      }
    }
    // Net of the coins the missing tiles will cost; coins have no value at
    // the end, but spending them here means not spending them elsewhere.
    const net = feas * (nw.reward - 0.5 * cost);
    if (net > bestValue) {
      bestValue = net;
      best = { word: nw.word, reward: nw.reward, missing: nw.missing, feasibility: feas, net };
    }
    if (net > 0) optionMass += net;
  }
  return { value: bestValue + p.optionBonus * Math.log1p(optionMass / 20), best };
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
  const efficiency = (3 * LETTER_VALUE[c]!) / Math.max(1, price);
  return dup * balance * vers * (1 + p.efficiencyWeight * (efficiency - 0.5));
}

export function moneyScale(view: MatchView, p: Params): number {
  const remaining = view.bagRemaining + 1;
  const avgPrice = p.priceA + p.priceB * 1.9; // bag-weighted mean letter value ~1.9
  const affordable = view.balance / avgPrice;
  const share = remaining * p.shareOfTiles;
  const pressure = affordable / Math.max(1, share);
  const t = Math.max(0, Math.min(1, pressure / 2));
  let scale = p.scaleLow + (p.scaleHigh - p.scaleLow) * t;
  if (p.relMoneyPow > 0 && view.opponents.length > 0 && remaining > p.spendDownFrom) {
    const oppMean = view.opponents.reduce((a, o) => a + Math.max(0, o.balance), 0) / view.opponents.length;
    const rel = (view.balance + 5) / (oppMean + 5);
    scale *= Math.pow(Math.max(0.4, Math.min(2.0, rel)), p.relMoneyPow);
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
    if (best.reward < p.autoPlayMinReward && !bloated && view.balance >= p.lowBalance) break;
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
