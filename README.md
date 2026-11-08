# Lexicoin — a ScrabbleBot auction bot

Team **Tai Force** · bot **Lexicoin** · built for Spacetime's ScrabbleBot
Tournament, Nov 7 2026 · game: https://scrabblebot.spacetimedb.com/

ScrabbleBot is an auction word game on [SpacetimeDB](https://spacetimedb.com):
six bots each get five tiles and 100 coins, then 68 one-second sealed-bid
Vickrey auctions sell the rest of a Scrabble bag one tile at a time. Bots play
dictionary words from their racks for points (letter values × a length
multiplier up to 3× for seven or more letters). Points also refill the
spendable balance; leftover coins are worth nothing at the end.

## Run it

```bash
cd bot
npm install
# token from https://scrabblebot.spacetimedb.com/team (shown once)
BOT_NAME=Lexicoin BOT_TOKEN=<token> npm start
# later runs: token is cached in bot/.token-Lexicoin
BOT_NAME=Lexicoin npm start
```

The bot joins the open lobby automatically, plays matches back to back, and
registers itself for any tournament that is taking registrations
(`AUTO_REGISTER=0` disables that, `TOURNAMENT_ID=<id>` targets one).

```bash
npm run sim            # offline simulator, 200 matches vs modelled opponents
npm run tune           # parameter sweep
npm run trace -- 3     # one simulated match, every bid explained
npm run pull           # cache 150 recorded live matches (top bots first)
npm run replay         # replay them with our strategy as a 7th bidder
npx tsx src/replay.ts 150 1 --sweep coinsPerPoint=1.5,2.5 --vs paceTotal=200
npx tsx src/pull_matches.ts 60 --ours && npx tsx src/replay.ts 60 1 --ours
                       # check: replayed vs real score in matches we played
```

The replay evaluator is the better yardstick: sealed-bid Vickrey bids don't
depend on each other, so inserting our bids against the recorded top bids
(win iff we bid more, pay their top bid) shows what our strategy would have
scored against the real field. Variants share deals, so `Δ` is paired.

## How it plays

**Economics.** Score counts word rewards only, and coins expire at the match
end, so the job is to convert the whole budget into tiles that complete
high-value long words. Every tile costs a market floor of ~10 coins plus a
premium for letter value; a 1-point vowel in a 7-letter word returns 3 points
for ~13 coins, a Z returns 30 for ~35. Heavy letters are the efficient buy;
cheap letters are filler.

**Valuation** (`bot/src/strategy.ts`). For the current rack the bot scans the
whole 172k-word dictionary for words of 7–9 letters that are at most three
tiles away, using packed letter counts and bitmasks (about 2–5 ms). Each
candidate is a *plan*: reward × probability the missing tiles still come up
(from the exact bag composition, which is public knowledge once you subtract
your own deal and everything auctioned) minus half the market cost of those
tiles. A letter's value is how much it raises the best plan plus an option
bonus for having many plans. The bid is that gain in coins, scaled by money
pressure: how our balance compares with the field's (all balances are public)
and with the number of auctions left.

**Building bids.** With a small rack no plan exists yet, so the bot buys
well-fitting tiles at the price needed to win (above the second price others
pay): fit combines vowel balance, duplicate penalties, how often the letter
appears in long words, and point efficiency, with a floor for heavy letters.

**Playing.** A 7+ letter word is cashed as soon as it pays enough (or the
rack is bloated); cheap 7-letter words are held because the same tiles can
grow into something better. When money runs low a mid-size word is sold to
keep bidding. In the last auctions the bot spends down to zero, never bids on
the final tile (it can't be played — the match ends when that auction
closes), only bids on the second-to-last if it completes a word immediately,
and cashes the whole rack with a small search over word combinations.

**Plumbing** (`bot/src/index.ts`). The match history is millions of rows, so
the bot subscribes to small global tables plus `WHERE match_id = …` queries
for the match it is seated in. Bids are decided on `auction` insert and land
a few milliseconds after the auction opens; words are played on rack changes
and on every auction close; it rejoins the lobby after each match, tracks
tournament status, and reconnects with backoff.

## Layout

| Path | What |
|---|---|
| `bot/src/engine.ts` | dictionary, rack arithmetic, scoring, playable / near-playable scans |
| `bot/src/strategy.ts` | valuation, bidding, play policy, tunable `Params` |
| `bot/src/index.ts` | SpacetimeDB client, subscriptions, match lifecycle |
| `bot/src/sim.ts` | match simulator with opponents calibrated to live top-bid data |
| `bot/src/tune.ts`, `trace.ts` | parameter sweeps and single-match traces |
| `bot/src/pull_matches.ts`, `replay.ts` | recorded-match cache (`bot/data/replay*/`) and replay evaluator |
| `bot/src/module_bindings/` | generated from the game module (`spacetime generate`) |
| `data/wordlist.txt` | ENABLE word list, same as the server |

Built on the official starter and module from
[clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot). MIT.
