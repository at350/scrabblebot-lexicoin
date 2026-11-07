// Word engine: dictionary loading, rack arithmetic, scoring, and fast scans
// for playable and near-playable words. Pure functions, no I/O except
// `loadDictionary`, so the simulator and the live bot share it.

import * as fs from "node:fs";

export const A_CODE = 65; // "A".charCodeAt(0)

// Standard Scrabble letter values (mirrors the module's letters.ts).
export const LETTER_VALUE: number[] = new Array(26).fill(0);
for (const [v, cs] of [
  [1, "AEIOULNSTR"],
  [2, "DG"],
  [3, "BCMP"],
  [4, "FHVWY"],
  [5, "K"],
  [8, "JX"],
  [10, "QZ"],
] as const) {
  for (const c of cs) LETTER_VALUE[c.charCodeAt(0) - A_CODE] = v;
}

// Standard 98-tile bag, no blanks (mirrors the module's DEFAULT_BAG).
export const BAG_COUNTS: number[] = new Array(26).fill(0);
for (const [c, n] of [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
] as const) {
  BAG_COUNTS[c.charCodeAt(0) - A_CODE] = n;
}
export const BAG_SIZE = 98;

export function letterIndex(c: string): number {
  return c.charCodeAt(0) - A_CODE;
}
export function indexLetter(i: number): string {
  return String.fromCharCode(A_CODE + i);
}

// Reward multiplier as (num, denom); reward = floor(base * num / denom).
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function wordBase(word: string): number {
  let b = 0;
  for (let i = 0; i < word.length; i++) b += LETTER_VALUE[word.charCodeAt(i) - A_CODE] ?? 0;
  return b;
}

export function wordReward(word: string): number {
  const [n, d] = lengthMultiplier(word.length);
  return Math.floor((wordBase(word) * n) / d);
}

// A rack is a 26-slot count vector.
export type Rack = Int32Array;

export function emptyRack(): Rack {
  return new Int32Array(26);
}
export function rackFromString(s: string): Rack {
  const r = emptyRack();
  for (const c of s.toUpperCase()) {
    const i = c.charCodeAt(0) - A_CODE;
    if (i >= 0 && i < 26) r[i]++;
  }
  return r;
}
export function rackFromMap(m: Map<string, number>): Rack {
  const r = emptyRack();
  for (const [c, n] of m) {
    const i = c.charCodeAt(0) - A_CODE;
    if (i >= 0 && i < 26) r[i] += n;
  }
  return r;
}
export function rackToString(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += indexLetter(i).repeat(r[i]);
  return s;
}
export function rackTotal(r: Rack): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += r[i];
  return t;
}
export function rackMask(r: Rack): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (r[i] > 0) m |= 1 << i;
  return m;
}
export function rackClone(r: Rack): Rack {
  return new Int32Array(r);
}
export function rackAdd(r: Rack, i: number, n = 1): Rack {
  const c = new Int32Array(r);
  c[i] += n;
  return c;
}
export function rackRemoveWord(r: Rack, word: string): Rack {
  const c = new Int32Array(r);
  for (let i = 0; i < word.length; i++) c[word.charCodeAt(i) - A_CODE]--;
  return c;
}
export function rackValue(r: Rack): number {
  let v = 0;
  for (let i = 0; i < 26; i++) v += r[i] * LETTER_VALUE[i];
  return v;
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export interface Dictionary {
  words: string[];
  lens: Uint8Array;
  masks: Int32Array;
  counts: Uint8Array; // N * 26
  base: Uint16Array;
  reward: Uint16Array;
  set: Set<string>;
  // Index ranges by length: words are sorted by length ascending.
  lenStart: number[]; // lenStart[L] = first index with length >= L
  maxLen: number;
  // Fraction of 7- and 8-letter words containing each letter: how
  // versatile a letter is for building long words.
  containFrac: number[];
}

export function buildDictionary(wordsIn: string[]): Dictionary {
  const words = wordsIn
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
  words.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const n = words.length;
  const lens = new Uint8Array(n);
  const masks = new Int32Array(n);
  const counts = new Uint8Array(n * 26);
  const base = new Uint16Array(n);
  const reward = new Uint16Array(n);
  let maxLen = 0;
  for (let k = 0; k < n; k++) {
    const w = words[k]!;
    lens[k] = w.length;
    if (w.length > maxLen) maxLen = w.length;
    let m = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - A_CODE;
      counts[k * 26 + c]++;
      m |= 1 << c;
    }
    masks[k] = m;
    base[k] = wordBase(w);
    reward[k] = wordReward(w);
  }
  const lenStart: number[] = new Array(maxLen + 2).fill(n);
  for (let k = n - 1; k >= 0; k--) lenStart[lens[k]!] = k;
  for (let L = maxLen; L >= 0; L--) if (lenStart[L]! > lenStart[L + 1]!) lenStart[L] = lenStart[L + 1]!;
  const containFrac = new Array<number>(26).fill(0);
  let longCount = 0;
  for (let k = lenStart[7]!; k < lenStart[9]!; k++) {
    longCount++;
    let m = masks[k]!;
    while (m !== 0) {
      const c = 31 - Math.clz32(m & -m);
      containFrac[c]!++;
      m &= m - 1;
    }
  }
  for (let c = 0; c < 26; c++) containFrac[c] = longCount ? containFrac[c]! / longCount : 0;
  return { words, lens, masks, counts, base, reward, set: new Set(words), lenStart, maxLen, containFrac };
}

export function loadDictionary(path: string): Dictionary {
  return buildDictionary(fs.readFileSync(path, "utf8").split("\n"));
}

export interface Playable {
  idx: number;
  word: string;
  reward: number;
  len: number;
}

// Every word the rack can spell, optionally restricted to [minLen, maxLen].
export function playableWords(d: Dictionary, rack: Rack, minLen = 2, maxLen = 99): Playable[] {
  const total = rackTotal(rack);
  const rm = rackMask(rack);
  const hi = Math.min(maxLen, total, d.maxLen);
  const out: Playable[] = [];
  if (hi < minLen) return out;
  const start = d.lenStart[minLen]!;
  const end = d.lenStart[hi + 1]!;
  const counts = d.counts;
  for (let k = start; k < end; k++) {
    if ((d.masks[k]! & ~rm) !== 0) continue;
    const off = k * 26;
    let ok = true;
    let m = d.masks[k]!;
    while (m !== 0) {
      const c = 31 - Math.clz32(m & -m);
      if (counts[off + c]! > rack[c]!) {
        ok = false;
        break;
      }
      m &= m - 1;
    }
    if (ok) out.push({ idx: k, word: d.words[k]!, reward: d.reward[k]!, len: d.lens[k]! });
  }
  return out;
}

export function bestPlayable(d: Dictionary, rack: Rack, minLen = 2): Playable | null {
  let best: Playable | null = null;
  for (const p of playableWords(d, rack, minLen)) {
    if (!best || p.reward > best.reward || (p.reward === best.reward && p.len < best.len)) best = p;
  }
  return best;
}

export interface NearWord {
  idx: number;
  word: string;
  reward: number;
  len: number;
  missing: number[]; // letter indexes still needed (with repeats)
}

// Words of length in [minLen, maxLen] that the rack can spell except for at
// most `maxMissing` tiles. Returns the missing tiles for each.
export function nearWords(
  d: Dictionary,
  rack: Rack,
  maxMissing: number,
  minLen: number,
  maxLen: number,
): NearWord[] {
  const total = rackTotal(rack);
  const rm = rackMask(rack);
  const hi = Math.min(maxLen, total + maxMissing, d.maxLen);
  const out: NearWord[] = [];
  if (hi < minLen) return out;
  const start = d.lenStart[minLen]!;
  const end = d.lenStart[hi + 1]!;
  const counts = d.counts;
  for (let k = start; k < end; k++) {
    const wm = d.masks[k]!;
    const absent = wm & ~rm;
    if (popcount(absent) > maxMissing) continue;
    const len = d.lens[k]!;
    if (len - total > maxMissing) continue;
    const off = k * 26;
    let missingCount = 0;
    let m = wm;
    let ok = true;
    while (m !== 0) {
      const c = 31 - Math.clz32(m & -m);
      const need = counts[off + c]! - rack[c]!;
      if (need > 0) {
        missingCount += need;
        if (missingCount > maxMissing) {
          ok = false;
          break;
        }
      }
      m &= m - 1;
    }
    if (!ok) continue;
    const missing: number[] = [];
    m = wm;
    while (m !== 0) {
      const c = 31 - Math.clz32(m & -m);
      const need = counts[off + c]! - rack[c]!;
      for (let j = 0; j < need; j++) missing.push(c);
      m &= m - 1;
    }
    out.push({ idx: k, word: d.words[k]!, reward: d.reward[k]!, len, missing });
  }
  return out;
}

// Greedy multi-word cash-out: repeatedly play the highest-reward word
// available, so the sum of rewards from the rack is (nearly) maximised.
export function greedyCashOut(d: Dictionary, rack: Rack, minLen = 2): Playable[] {
  const plays: Playable[] = [];
  let r = rackClone(rack);
  for (;;) {
    const best = bestPlayable(d, r, minLen);
    if (!best) break;
    plays.push(best);
    r = rackRemoveWord(r, best.word);
  }
  return plays;
}

// Cash-out with a one-level search: try each of the top `width` first words,
// finish greedily, and keep the best total. Catches cases where the single
// best word strands tiles that two medium words would have used.
export function bestCashOut(d: Dictionary, rack: Rack, width = 12, minLen = 2): Playable[] {
  const candidates = playableWords(d, rack, minLen).sort((a, b) => b.reward - a.reward || a.len - b.len);
  if (candidates.length === 0) return [];
  let best: Playable[] = [];
  let bestTotal = -1;
  const seen = new Set<string>();
  for (const first of candidates) {
    if (seen.size >= width) break;
    // Skip anagram duplicates: same letters give the same remainder.
    const key = [...first.word].sort().join("");
    if (seen.has(key)) continue;
    seen.add(key);
    const rest = greedyCashOut(d, rackRemoveWord(rack, first.word), minLen);
    const total = first.reward + rest.reduce((s, w) => s + w.reward, 0);
    if (total > bestTotal) {
      bestTotal = total;
      best = [first, ...rest];
    }
  }
  return best;
}
