// Pull recorded live matches for the replay evaluator (`replay.ts`).
//
//   npx tsx src/pull_matches.ts [count=150] [loId=42800] [hiId=99999999]
//
// Picks the most recent ended Vickrey matches in [loId, hiId] that have six
// participants, ranked by how many top bots sat in them, and caches each one
// to bot/data/replay/<match_id>.json: every auction in order (letter, winning
// bid, second price, winner) plus every word play and the final scores.
// Matches already on disk are not fetched again. Matches our own bot (199)
// played in are skipped.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const OUR_BOT_ID = 199;
// Top of the live leaderboard: matches with these bots are pulled first.
export const TOP_BOTS = [207, 201, 192, 171, 193, 180, 178, 172, 190, 114, 18];

export interface ReplayAuction {
  id: number;
  letter: string;
  opensAt: number; // ms since epoch
  closesAt: number;
  topBid: number; // winning bid; 0 when nobody bid
  paid: number; // second price actually paid; 0 when unsold
  winner: number | null;
}

export interface ReplayPlay {
  botId: number;
  word: string;
  reward: number;
  playedAt: number;
}

export interface ReplayMatch {
  matchId: number;
  participants: { botId: number; name: string; score: number; balance: number }[];
  auctions: ReplayAuction[];
  plays: ReplayPlay[];
}

export const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "replay");

// ---------- spacetime sql ----------

function runSql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("spacetime", ["sql", "scrabblebot", sql]);
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`spacetime sql failed (${code}): ${err || out}\n${sql}`))));
  });
}

// Unwrap the CLI's SATS notation: `"L"`, `(some = 166)`, `(none = ())`,
// `(ended = ())`, `(some = (__timestamp_micros_since_unix_epoch__ = ...))`.
function cell(raw: string): string | null {
  let s = raw.trim();
  for (;;) {
    if (s === "(none = ())") return null;
    const m = /^\((\w+) = (.*)\)$/.exec(s);
    if (!m) break;
    if (m[2] === "()") return m[1]!;
    s = m[2]!.trim();
  }
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

// Parse the ASCII table into rows keyed by column name.
export function parseTable(text: string): Record<string, string | null>[] {
  const lines = text.split("\n");
  const sep = lines.findIndex((l) => /^-+(\+-+)*\s*$/.test(l));
  if (sep < 1) return [];
  const header = lines[sep - 1]!.split("|").map((h) => h.trim());
  const rows: Record<string, string | null>[] = [];
  for (const line of lines.slice(sep + 1)) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length !== header.length) continue;
    const row: Record<string, string | null> = {};
    header.forEach((h, i) => (row[h] = cell(parts[i]!)));
    rows.push(row);
  }
  return rows;
}

export async function query(sql: string, retries = 2): Promise<Record<string, string | null>[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return parseTable(await runSql(sql));
    } catch (e) {
      if (attempt >= retries) throw e;
    }
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const num = (s: string | null | undefined) => (s === null || s === undefined ? 0 : Number(s));
const time = (s: string | null | undefined) => (s ? Date.parse(s) : 0);

// Group sorted ids into ranges no wider than `span`.
function ranges(ids: number[], span: number): [number, number][] {
  const out: [number, number][] = [];
  for (const id of ids) {
    const last = out[out.length - 1];
    if (last && id - last[0] < span) last[1] = id;
    else out.push([id, id]);
  }
  return out;
}

async function main() {
  const count = Number(process.argv[2] ?? 150);
  const lo = Number(process.argv[3] ?? 42800);
  const hi = Number(process.argv[4] ?? 99999999);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t0 = performance.now();

  const [states, parts, bots] = await Promise.all([
    query(`SELECT id, status, auction_type FROM match_state WHERE id >= ${lo} AND id <= ${hi}`),
    query(`SELECT * FROM match_participant WHERE match_id >= ${lo} AND match_id <= ${hi}`),
    query(`SELECT id, name FROM bot`),
  ]);
  const names = new Map(bots.map((b) => [num(b.id), b.name ?? "?"]));
  const byMatch = new Map<number, { botId: number; score: number; balance: number }[]>();
  for (const p of parts) {
    const m = num(p.match_id);
    if (!byMatch.has(m)) byMatch.set(m, []);
    byMatch.get(m)!.push({ botId: num(p.bot_id), score: num(p.score), balance: num(p.balance) });
  }
  const top = new Set(TOP_BOTS);
  const candidates = states
    .filter((s) => s.status === "ended" && s.auction_type === "vickrey")
    .map((s) => num(s.id))
    .filter((id) => {
      const ps = byMatch.get(id);
      return ps && ps.length === 6 && !ps.some((p) => p.botId === OUR_BOT_ID) && ps.some((p) => p.score > 0);
    })
    .map((id) => ({ id, topCount: byMatch.get(id)!.filter((p) => top.has(p.botId)).length }))
    // Most top bots first, then most recent.
    .sort((a, b) => b.topCount - a.topCount || b.id - a.id);
  const chosen = candidates.slice(0, count).map((c) => c.id).sort((a, b) => a - b);
  const missing = chosen.filter((id) => !fs.existsSync(path.join(DATA_DIR, `${id}.json`)));
  const hist = new Map<number, number>();
  for (const c of candidates.slice(0, count)) hist.set(c.topCount, (hist.get(c.topCount) ?? 0) + 1);
  console.log(
    `${candidates.length} eligible matches in [${lo}, ${hi}]; chose ${chosen.length} (top-bot counts: ${[...hist].sort((a, b) => b[0] - a[0]).map(([k, v]) => `${k}:${v}`).join(" ")}); fetching ${missing.length}`,
  );

  // Fetch the per-match tables in ranges of up to 40 match ids.
  const tasks: { table: string; lo: number; hi: number }[] = [];
  for (const [a, b] of ranges(missing, 40)) {
    for (const table of ["auction", "auction_result", "auction_top_bid_archive", "word_play"]) tasks.push({ table, lo: a, hi: b });
  }
  let done = 0;
  const results = await pool(tasks, 8, async (t) => {
    const rows = await query(`SELECT * FROM ${t.table} WHERE match_id >= ${t.lo} AND match_id <= ${t.hi}`);
    done++;
    if (done % 8 === 0 || done === tasks.length) process.stdout.write(`  ${done}/${tasks.length} queries\r`);
    return { ...t, rows };
  });
  if (tasks.length) process.stdout.write("\n");

  const want = new Set(missing);
  const auctions = new Map<number, ReplayAuction[]>();
  const resultRows = new Map<number, Record<string, string | null>>();
  const topRows = new Map<number, number>();
  const plays = new Map<number, ReplayPlay[]>();
  for (const r of results) {
    for (const row of r.rows) {
      const m = num(row.match_id);
      if (!want.has(m)) continue;
      switch (r.table) {
        case "auction":
          if (!auctions.has(m)) auctions.set(m, []);
          auctions.get(m)!.push({
            id: num(row.id),
            letter: row.letter ?? "?",
            opensAt: time(row.opens_at),
            closesAt: time(row.closes_at),
            topBid: 0,
            paid: 0,
            winner: null,
          });
          break;
        case "auction_result":
          resultRows.set(num(row.auction_id), row);
          break;
        case "auction_top_bid_archive":
          topRows.set(num(row.auction_id), num(row.top_bid));
          break;
        case "word_play":
          if (!plays.has(m)) plays.set(m, []);
          plays.get(m)!.push({ botId: num(row.bot_id), word: row.word ?? "", reward: num(row.total_reward), playedAt: time(row.played_at) });
          break;
      }
    }
  }

  let written = 0;
  for (const id of missing) {
    const as = (auctions.get(id) ?? []).sort((a, b) => a.id - b.id);
    if (as.length !== 68) {
      console.log(`  skip ${id}: ${as.length} auctions`);
      continue;
    }
    for (const a of as) {
      const res = resultRows.get(a.id);
      a.winner = res?.winner_bot_id ? num(res.winner_bot_id) : null;
      a.paid = num(res?.paid);
      if (res?.closed_at) a.closesAt = time(res.closed_at);
      a.topBid = topRows.get(a.id) ?? (a.winner !== null ? a.paid : 0);
    }
    const match: ReplayMatch = {
      matchId: id,
      participants: byMatch.get(id)!.map((p) => ({ ...p, name: names.get(p.botId) ?? "?" })),
      auctions: as,
      plays: (plays.get(id) ?? []).sort((a, b) => a.playedAt - b.playedAt),
    };
    fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(match));
    written++;
  }
  console.log(`wrote ${written} matches to ${DATA_DIR} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("pull_matches.ts");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
