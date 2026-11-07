// Trace one simulated match from our bot's point of view.
import * as path from "node:path";
import { BAG_COUNTS, LETTER_VALUE, emptyRack, indexLetter, loadDictionary, rackClone, rackRemoveWord, rackToString, rackTotal, bestPlayable, greedyCashOut } from "./engine.js";
import { DEFAULT_PARAMS, decideBid, decidePlays, type MatchView, type Params } from "./strategy.js";
import { rng } from "./sim.js";

const d = loadDictionary(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "wordlist.txt"));
const seed = Number(process.argv[2] ?? 3);
const over: Partial<Params> = JSON.parse(process.env.PARAMS ?? "{}");
const p = { ...DEFAULT_PARAMS, ...over };
const r = rng(seed);
const bag = new Int32Array(BAG_COUNTS);
function draw() { const t = rackTotal(bag); let i = r.int(0, t - 1); for (let c = 0; c < 26; c++) { if (i < bag[c]!) { bag[c]--; return c; } i -= bag[c]!; } throw 0; }
// 5 opponents modelled simply: bid 9+1.8v+noise, boost when completing 7.
const opp = Array.from({ length: 5 }, () => ({ rack: emptyRack(), balance: 100, score: 0 }));
const me = { rack: emptyRack(), balance: 100, score: 0 };
for (const q of [me, ...opp]) for (let i = 0; i < 5; i++) q.rack[draw()]++;
const initial = rackClone(me.rack);
const auctioned = emptyRack();
console.log("initial rack", rackToString(me.rack));
let t0 = performance.now();
while (rackTotal(bag) > 0) {
  const c = draw(); auctioned[c]++;
  const bagRemaining = rackTotal(bag);
  const pool = emptyRack(); for (let i = 0; i < 26; i++) pool[i] = BAG_COUNTS[i]! - initial[i]! - auctioned[i]!;
  const view: MatchView = { rack: me.rack, balance: me.balance, score: me.score, bagRemaining, pool, auctionType: "Vickrey", opponents: opp.map(o => ({ balance: o.balance, score: o.score })) };
  const ta = performance.now();
  const bid = decideBid(d, indexLetter(c), view, p);
  const tb = performance.now();
  const bids: { who: number; amt: number }[] = [{ who: -1, amt: bid.amount }];
  opp.forEach((o, i) => {
    if (bagRemaining <= 0) return;
    let b = 9 + 1.8 * LETTER_VALUE[c]! + 2.5 * r.gauss();
    const w = rackClone(o.rack); w[c]++;
    const now = bestPlayable(d, o.rack, 7)?.reward ?? 0, then = bestPlayable(d, w, 7)?.reward ?? 0;
    if (then > now) b += 0.6 * (then - now);
    if (bagRemaining <= 5) b = Math.max(b, o.balance / (bagRemaining + 1));
    bids.push({ who: i, amt: Math.max(0, Math.min(o.balance, Math.round(b))) });
  });
  const live = bids.filter(b => b.amt > 0).sort((a, b) => b.amt - a.amt);
  let line = `#${68 - bagRemaining} ${indexLetter(c)} bag=${bagRemaining} rack=${rackToString(me.rack)} bal=${me.balance} bid=${bid.amount} [${bid.reason}] ${(tb - ta).toFixed(1)}ms`;
  if (live.length) {
    const w = live[0]!, paid = live[1]?.amt ?? 1;
    if (w.who === -1) { me.balance -= paid; me.rack[c]++; line += ` -> WON paid ${paid}`; }
    else { const o = opp[w.who]!; o.balance -= paid; o.rack[c]++; line += ` -> opp${w.who} paid ${paid} (top ${w.amt})`; }
  }
  console.log(line);
  if (bagRemaining > 0) {
    for (let g = 0; g < 5; g++) { const plays = decidePlays(d, { ...view, rack: me.rack, balance: me.balance }, p); if (!plays.length) break; for (const w of plays) { me.rack = rackRemoveWord(me.rack, w.word); me.balance += w.reward; me.score += w.reward; console.log(`   PLAY ${w.word} +${w.reward} -> score ${me.score} bal ${me.balance}`); } }
    for (const o of opp) { for (;;) { const b = bestPlayable(d, o.rack, 7); if (!b) break; o.rack = rackRemoveWord(o.rack, b.word); o.balance += b.reward; o.score += b.reward; } if (bagRemaining <= 1) for (const w of greedyCashOut(d, o.rack, 2)) { o.rack = rackRemoveWord(o.rack, w.word); o.score += w.reward; } }
  }
}
console.log(`FINAL me score=${me.score} bal=${me.balance} rack=${rackToString(me.rack)} | opp scores ${opp.map(o => o.score).join(",")} total ${((performance.now() - t0) / 1000).toFixed(1)}s`);
