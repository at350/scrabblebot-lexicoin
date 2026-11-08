// Lexicoin: a ScrabbleBot auction bot.
//
//   BOT_NAME=Lexicoin BOT_TOKEN=<token> npm start      # first run
//   BOT_NAME=Lexicoin npm start                        # token cached in .token-<name>
//   BOT_NAME=Lexicoin BOT_NONCE=<code> npm start       # claim a CLI-minted nonce
//   TOURNAMENT_ID=<id> ...                             # register for a tournament
//   AUTO_REGISTER=0 ...                                # don't auto-register for open tournaments
//
// Strategy lives in strategy.ts; this file is the SpacetimeDB plumbing:
// filtered subscriptions (the full auction history is millions of rows),
// match state tracking, bidding on auction open, playing words on rack
// change, lobby re-entry and tournament registration.

import * as fs from "node:fs";
import * as path from "node:path";
import { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext, type EventContext } from "./module_bindings/index.js";
import {
  BAG_COUNTS,
  emptyRack,
  letterIndex,
  loadDictionary,
  rackFromMap,
  rackToString,
  rackTotal,
  type Rack,
} from "./engine.js";
import {
  DEFAULT_PARAMS,
  decideBid,
  decidePlays,
  refreshDistribution,
  type MatchView,
  type Params,
} from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "Lexicoin";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const AUTO_REGISTER = (process.env.AUTO_REGISTER ?? "1") !== "0";
const AUTO_LOBBY = (process.env.AUTO_LOBBY ?? "1") !== "0";
// Once registered for a tournament that hasn't started, stay out of casual
// matches so the admin can start it without waiting for us.
const LOBBY_WHILE_REGISTERED = (process.env.LOBBY_WHILE_REGISTERED ?? "0") !== "0";
const VERBOSE = (process.env.VERBOSE ?? "1") !== "0";
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const PARAMS: Params = { ...DEFAULT_PARAMS, allowStaleDistribution: true, ...(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {}) };

const here = path.dirname(new URL(import.meta.url).pathname);
const DICT_PATH = process.env.WORDLIST ?? path.join(here, "..", "..", "data", "wordlist.txt");

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function log(msg: string) {
  console.log(`${ts()} [${BOT_NAME}] ${msg}`);
}
function warn(msg: string) {
  console.warn(`${ts()} [${BOT_NAME}] WARN ${msg}`);
}

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

log(`loading dictionary from ${DICT_PATH}`);
const t0 = performance.now();
const DICT = loadDictionary(DICT_PATH);
log(`dictionary: ${DICT.words.length} words in ${(performance.now() - t0).toFixed(0)}ms`);

// ---------- Per-match state ----------

interface MatchTrack {
  matchId: bigint;
  paidByValue: number[][]; // observed second prices by letter value
  bidsSubmitted: Map<string, number>; // auction id -> amount we last submitted (0 = passed)
  subscribed: boolean;
  bids: number;
  wins: number;
  spent: number;
}

const tracks = new Map<string, MatchTrack>();

function trackFor(matchId: bigint): MatchTrack {
  const key = String(matchId);
  let t = tracks.get(key);
  if (!t) {
    t = {
      matchId,
      paidByValue: Array.from({ length: 11 }, () => []),
      bidsSubmitted: new Map(),
      subscribed: false,
      bids: 0,
      wins: 0,
      spent: 0,
    };
    tracks.set(key, t);
  }
  return t;
}

// ---------- Connection state ----------

let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let baseApplied = false;
let registeredTournaments = new Set<string>();
let reconnectDelay = 1000;
let lobbyTimer: NodeJS.Timeout | null = null;

function resolveMyBotId(c: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = c.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(c: DbConnection, matchId: bigint): Rack {
  const m = new Map<string, number>();
  for (const h of c.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    m.set(h.letter, (m.get(h.letter) ?? 0) + h.count);
  }
  return rackFromMap(m);
}

function participant(c: DbConnection, matchId: bigint) {
  if (myBotId === null) return null;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId === myBotId) return p;
  }
  return null;
}

function buildView(c: DbConnection, matchId: bigint): MatchView | null {
  const m = c.db.matchState.id.find(matchId);
  const me = participant(c, matchId);
  if (!m || !me) return null;
  const t = trackFor(matchId);
  const rack = rackForMatch(c, matchId);
  // Everything is derived from the cached tables, so a mid-match
  // (re)connect still gets the right accounting.
  const auctioned = emptyRack();
  for (const a of c.db.auction.iter()) {
    if (a.matchId !== matchId) continue;
    const li = letterIndex(a.letter);
    if (li >= 0 && li < 26) auctioned[li]!++;
  }
  const won = emptyRack();
  t.paidByValue = Array.from({ length: 11 }, () => []);
  for (const r of c.db.auctionResult.iter()) {
    if (r.matchId !== matchId) continue;
    const li = letterIndex(r.letter);
    if (li < 0 || li > 25) continue;
    if (r.winnerBotId === myBotId) won[li]!++;
    if (r.winnerBotId !== undefined && r.winnerBotId !== null && Number(r.paid) > 0) t.paidByValue[valueOf(li)]!.push(Number(r.paid));
  }
  const played = emptyRack();
  for (const w of c.db.wordPlay.iter()) {
    if (w.matchId !== matchId || w.botId !== myBotId) continue;
    for (const ch of w.word) {
      const li = letterIndex(ch);
      if (li >= 0 && li < 26) played[li]!++;
    }
  }
  // Initial deal = what we hold now, minus what we won, plus what we spent.
  const pool = emptyRack();
  for (let i = 0; i < 26; i++) {
    const initial = Math.max(0, rack[i]! - won[i]! + played[i]!);
    pool[i] = Math.max(0, BAG_COUNTS[i]! - initial - auctioned[i]!);
  }
  const opponents: { balance: number; score: number }[] = [];
  for (const p of c.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId !== myBotId) opponents.push({ balance: Number(p.balance), score: Number(p.score) });
  }
  const priceByValue: (number | undefined)[] = t.paidByValue.map((xs) => (xs.length >= 2 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined));
  return {
    rack,
    balance: Number(me.balance),
    score: Number(me.score),
    bagRemaining: m.bagTotal,
    pool,
    auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    opponents,
    priceByValue,
  };
}

// ---------- Actions ----------

function tryBid(c: DbConnection, a: { id: bigint; matchId: bigint; letter: string; opensAt: { microsSinceUnixEpoch: bigint }; status: { tag: string } }, rebid = false) {
  if (myBotId === null) return;
  if (a.status.tag !== "Open") return;
  const t = trackFor(a.matchId);
  const key = String(a.id);
  const previous = t.bidsSubmitted.get(key);
  if (previous !== undefined && !rebid) return;
  const me = participant(c, a.matchId);
  if (!me) return; // not our match
  if (!rebid) t.bidsSubmitted.set(key, 0);
  const view = buildView(c, a.matchId);
  if (!view) return;
  const started = performance.now();
  const decision = decideBid(DICT, a.letter, view, PARAMS);
  const ms = performance.now() - started;
  // Refresh the letter ranking after this bid goes out, off the hot path.
  setImmediate(() => {
    const t0 = performance.now();
    if (refreshDistribution() && VERBOSE) log(`m${a.matchId} ranking refreshed in ${(performance.now() - t0).toFixed(0)}ms`);
  });
  const openedMs = Number(a.opensAt.microsSinceUnixEpoch / 1000n);
  const sinceOpen = Date.now() - openedMs;
  // A re-bid only matters if we can now bid more than before.
  if (rebid && decision.amount <= (previous ?? 0)) return;
  if (decision.amount <= 0) {
    if (VERBOSE) log(`m${a.matchId} '${a.letter}' bag=${view.bagRemaining} rack=${rackToString(view.rack)} bal=${view.balance} -> pass [${decision.reason}] ${ms.toFixed(1)}ms +${sinceOpen}ms`);
    return;
  }
  t.bidsSubmitted.set(key, decision.amount);
  if (!rebid) t.bids++;
  c.reducers
    .submitBid({ auctionId: a.id, amount: BigInt(decision.amount) })
    .catch((err: unknown) => warn(`bid ${decision.amount} on '${a.letter}' (auction ${a.id}) failed: ${err instanceof Error ? err.message : err}`));
  if (VERBOSE) log(`m${a.matchId} '${a.letter}' bag=${view.bagRemaining} rack=${rackToString(view.rack)} bal=${view.balance} -> ${rebid ? "REBID" : "bid"} ${decision.amount} [${decision.reason}] ${ms.toFixed(1)}ms +${sinceOpen}ms`);
}

// After a word pays out mid-auction, the open auction may deserve a bigger
// bid than the one we placed (or the pass) while poorer.
function rebidOpen(c: DbConnection, matchId: bigint) {
  for (const a of c.db.auction.iter()) {
    if (a.matchId === matchId && a.status.tag === "Open") tryBid(c, a, true);
  }
}

const playInFlight = new Map<string, number>();

function tryPlay(c: DbConnection, matchId: bigint, why: string) {
  if (myBotId === null) return;
  const m = c.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;
  const view = buildView(c, matchId);
  if (!view) return;
  const plays = decidePlays(DICT, view, PARAMS);
  if (plays.length === 0) return;
  const key = String(matchId);
  const now = Date.now();
  // Don't resend the same plan while the first is still in flight.
  if (now - (playInFlight.get(key) ?? 0) < 250) return;
  playInFlight.set(key, now);
  for (const w of plays) {
    log(`m${matchId} PLAY ${w.word} (+${w.reward}) [${why}] rack=${rackToString(view.rack)}`);
    c.reducers
      .submitWord({ matchId, word: w.word })
      .catch((err: unknown) => warn(`play '${w.word}' failed: ${err instanceof Error ? err.message : err}`));
  }
}

function inRunningMatch(c: DbConnection): bigint | null {
  if (myBotId === null) return null;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = c.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") return p.matchId;
  }
  return null;
}

function heldForTournament(c: DbConnection): boolean {
  if (myBotId === null) return false;
  for (const e of c.db.tournamentEntry.iter()) {
    if (e.botId !== myBotId || e.eliminated) continue;
    const t = c.db.tournament.id.find(e.tournamentId);
    if (!t) continue;
    const s = t.status.tag;
    if (s === "Swiss" || s === "Bracket" || s === "Final") return true;
  }
  return false;
}

function awaitingTournament(c: DbConnection): boolean {
  if (myBotId === null) return false;
  for (const e of c.db.tournamentEntry.iter()) {
    if (e.botId !== myBotId) continue;
    if (c.db.tournament.id.find(e.tournamentId)?.status.tag === "Registration") return true;
  }
  return false;
}

function joinLobby(c: DbConnection, why: string) {
  if (!AUTO_LOBBY || myBotId === null) return;
  if (inRunningMatch(c) !== null) return;
  if (heldForTournament(c)) return;
  if (!LOBBY_WHILE_REGISTERED && awaitingTournament(c)) {
    if (why !== "periodic") log(`registered for a pending tournament; staying out of the lobby [${why}]`);
    return;
  }
  let open: { id: bigint } | null = null;
  for (const l of c.db.openLobbies.iter()) open = l;
  if (open) {
    for (const lm of c.db.openLobbyMembers.iter()) {
      if (lm.lobbyId === open.id && lm.botId === myBotId) return; // already queued
    }
  }
  log(`joining lobby [${why}]`);
  c.reducers.joinLobby({}).catch((err: unknown) => warn(`join lobby failed: ${err instanceof Error ? err.message : err}`));
}

function registerTournaments(c: DbConnection) {
  if (myBotId === null) return;
  const wanted = new Set<string>();
  if (TOURNAMENT_ID) wanted.add(TOURNAMENT_ID);
  if (AUTO_REGISTER) {
    for (const t of c.db.tournament.iter()) if (t.status.tag === "Registration") wanted.add(String(t.id));
  }
  for (const id of wanted) {
    if (registeredTournaments.has(id)) continue;
    let already = false;
    for (const e of c.db.tournamentEntry.iter()) if (e.botId === myBotId && String(e.tournamentId) === id) already = true;
    registeredTournaments.add(id);
    if (already) {
      log(`already registered for tournament ${id}`);
      continue;
    }
    c.reducers
      .registerForTournament({ tournamentId: BigInt(id) })
      .then(() => log(`registered for tournament ${id}`))
      .catch((err: unknown) => {
        warn(`register for tournament ${id} failed: ${err instanceof Error ? err.message : err}`);
        registeredTournaments.delete(id);
      });
  }
}

// Subscribe to the live tables of one match.
function subscribeMatch(c: DbConnection, matchId: bigint) {
  const t = trackFor(matchId);
  if (t.subscribed) return;
  t.subscribed = true;
  const id = matchId.toString();
  c.subscriptionBuilder()
    .onApplied(() => {
      log(`m${matchId} subscribed`);
      // Catch up on anything already there.
      for (const a of c.db.auction.iter()) if (a.matchId === matchId && a.status.tag === "Open") tryBid(c, a);
      tryPlay(c, matchId, "match subscribed");
    })
    .onError((ctx) => warn(`match subscription error: ${ctx.event?.message ?? ctx.event}`))
    .subscribe([
      `SELECT * FROM auction WHERE match_id = ${id}`,
      `SELECT * FROM auction_result WHERE match_id = ${id}`,
      `SELECT * FROM word_play WHERE match_id = ${id}`,
      `SELECT * FROM match_participant WHERE match_id = ${id}`,
    ]);
}

function onBotReady(c: DbConnection) {
  subscribeParticipants(c);
  const bot = c.db.bot.id.find(myBotId!);
  log(`acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
  registerTournaments(c);
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = c.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") subscribeMatch(c, p.matchId);
  }
  joinLobby(c, "startup");
  if (lobbyTimer) clearInterval(lobbyTimer);
  lobbyTimer = setInterval(() => {
    if (!conn) return;
    joinLobby(conn, "periodic");
    registerTournaments(conn);
    const mid = inRunningMatch(conn);
    if (mid !== null) tryPlay(conn, mid, "periodic");
  }, 10_000);
}

function wireCallbacks(c: DbConnection) {
  c.db.auction.onInsert((_ctx: EventContext, a) => tryBid(c, a));
  c.db.auction.onUpdate((_ctx: EventContext, _old, a) => {
    if (a.status.tag === "Open") tryBid(c, a);
  });

  c.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const t = tracks.get(String(r.matchId));
    if (!t) return;
    const winner = r.winnerBotId;
    if (winner === myBotId) {
      t.wins++;
      t.spent += Number(r.paid);
    }
    if (VERBOSE) log(`m${r.matchId} result '${r.letter}' -> ${winner === myBotId ? "US" : winner ?? "nobody"} paid ${r.paid}`);
    // Endgame plays are triggered by auction closes, not just rack changes.
    tryPlay(c, r.matchId, "auction closed");
  });

  c.db.wordPlay.onInsert((_ctx, w) => {
    if (myBotId === null) return;
    const t = tracks.get(String(w.matchId));
    if (!t) return;
    if (w.botId === myBotId) {
      log(`m${w.matchId} played ${w.word} +${w.totalReward}`);
    } else if (VERBOSE) {
      log(`m${w.matchId} opp ${w.botId} played ${w.word} +${w.totalReward}`);
    }
  });

  c.db.myRack.onInsert((_ctx, h) => tryPlay(c, h.matchId, "rack insert"));
  c.db.myRack.onUpdate((_ctx, _o, h) => tryPlay(c, h.matchId, "rack update"));
  c.db.myRack.onDelete((_ctx, h) => tryPlay(c, h.matchId, "rack delete"));

  c.db.matchParticipant.onUpdate((_ctx, old, p) => {
    if (myBotId === null || p.botId !== myBotId) return;
    if (p.balance > old.balance) rebidOpen(c, p.matchId);
  });

  c.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId === null || p.botId !== myBotId) return;
    const m = c.db.matchState.id.find(p.matchId);
    if (m?.status.tag !== "Running") return;
    log(`m${p.matchId} we are seated`);
    subscribeMatch(c, p.matchId);
  });

  c.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const me = participant(c, neu.id);
      if (me) {
        const t = tracks.get(String(neu.id));
        const all = [...c.db.matchParticipant.iter()].filter((p) => p.matchId === neu.id).sort((a, b) => Number(b.score - a.score));
        const place = all.findIndex((p) => p.botId === myBotId) + 1;
        log(`m${neu.id} ENDED: score=${me.score} balance=${me.balance} place=${place}/${all.length} bids=${t?.bids ?? 0} wins=${t?.wins ?? 0} spent=${t?.spent ?? 0}; scores=${all.map((p) => `${c.db.bot.id.find(p.botId)?.name ?? p.botId}:${p.score}`).join(" ")}`);
        setTimeout(() => conn && joinLobby(conn, "match ended"), 300);
      }
    }
  });

  c.db.tournament.onInsert((_ctx, t) => {
    log(`tournament ${t.id} ${t.status.tag} (${t.auctionType.tag}, size ${t.matchSize}, swiss ${t.swissRoundsTotal}, cut ${t.topCut})`);
    registerTournaments(c);
  });
  c.db.tournament.onUpdate((_ctx, _o, t) => {
    log(`tournament ${t.id} -> ${t.status.tag} round ${t.currentRound}`);
    if (t.status.tag === "Ended" || t.status.tag === "ForceEnded") setTimeout(() => conn && joinLobby(conn, "tournament over"), 500);
  });
  c.db.tournamentEntry.onUpdate((_ctx, _o, e) => {
    if (e.botId === myBotId && e.eliminated) {
      log(`eliminated from tournament ${e.tournamentId} (swiss ${e.swissPoints}, total ${e.totalScore})`);
      setTimeout(() => conn && joinLobby(conn, "eliminated"), 500);
    }
  });

  c.db.botCredential.onInsert(() => {
    if (myBotId === null) {
      myBotId = resolveMyBotId(c);
      if (myBotId !== null && baseApplied) onBotReady(c);
    }
  });
}

function valueOf(li: number): number {
  // LETTER_VALUE lives in engine; keep a tiny local copy to avoid a cycle.
  return "AEIOULNSTR".includes(String.fromCharCode(65 + li))
    ? 1
    : "DG".includes(String.fromCharCode(65 + li))
      ? 2
      : "BCMP".includes(String.fromCharCode(65 + li))
        ? 3
        : "FHVWY".includes(String.fromCharCode(65 + li))
          ? 4
          : li === 10
            ? 5
            : "JX".includes(String.fromCharCode(65 + li))
              ? 8
              : 10;
}

function onConnect(c: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  reconnectDelay = 1000;
  log(`connected as ${identity.toHexString()}`);
  wireCallbacks(c);

  c.subscriptionBuilder()
    .onApplied(() => {
      baseApplied = true;
      log("base subscription applied");
      myBotId = resolveMyBotId(c);
      if (myBotId === null) {
        if (BOT_NONCE) {
          log("claiming credential with nonce…");
          c.reducers
            .claimCredential({ code: BOT_NONCE })
            .then(() => {
              myBotId = resolveMyBotId(c);
              if (myBotId !== null) onBotReady(c);
            })
            .catch((err: unknown) => {
              console.error(`claim failed: ${err instanceof Error ? err.message : err}`);
              process.exit(1);
            });
          return;
        }
        console.error("No bot credential for this token. Set BOT_TOKEN (from /team) or BOT_NONCE (from the CLI).");
        process.exit(1);
      }
      onBotReady(c);
    })
    .onError((ctx) => {
      warn(`base subscription error: ${ctx.event?.message ?? ctx.event}`);
    })
    .subscribe([
      "SELECT * FROM bot",
      "SELECT * FROM bot_credential",
      "SELECT * FROM match_state",
      "SELECT * FROM my_rack",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
      "SELECT * FROM tournament",
      "SELECT * FROM tournament_entry",
      "SELECT * FROM matchmaker_config",
    ]);
}

// Our own participant rows tell us which matches we're in. Subscribed
// separately once we know our bot id (we may not, before a nonce claim).
let participantSubscribed = false;
function subscribeParticipants(c: DbConnection) {
  if (participantSubscribed || myBotId === null) return;
  participantSubscribed = true;
  c.subscriptionBuilder()
    .onApplied(() => {
      log("participant subscription applied");
      for (const p of c.db.matchParticipant.iter()) {
        if (p.botId !== myBotId) continue;
        const m = c.db.matchState.id.find(p.matchId);
        if (m?.status.tag === "Running") subscribeMatch(c, p.matchId);
      }
    })
    .onError((ctx) => warn(`participant subscription error: ${ctx.event?.message ?? ctx.event}`))
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId.toString()}`]);
}

function connect() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  baseApplied = false;
  participantSubscribed = false;
  tracks.clear();
  const c = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect((cc, id, tok) => {
      conn = cc;
      onConnect(cc, id, tok);
    })
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error(`${ts()} connect error: ${err.message}`);
      scheduleReconnect();
    })
    .onDisconnect(() => {
      warn("disconnected");
      conn = null;
      scheduleReconnect();
    })
    .build();
  return c;
}

let reconnectTimer: NodeJS.Timeout | null = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  warn(`reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

process.on("uncaughtException", (err) => {
  console.error(`${ts()} uncaught: ${err.stack ?? err}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`${ts()} unhandled rejection: ${err instanceof Error ? err.stack : err}`);
});

connect();
setInterval(() => {
  if (!conn) return;
  const mid = inRunningMatch(conn);
  log(`heartbeat: ${mid !== null ? `in match ${mid}` : "idle"}; rack rows=${[...conn.db.myRack.iter()].length}`);
}, 60_000);

export {};
