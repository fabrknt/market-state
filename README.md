# market-state

**Halt and session state for tokenized stocks, which readers fail closed on.**

A tokenized stock can trade onchain while its primary listing is halted. The usual cases are a news
pending halt, a volatility pause, an SEC suspension, or a market-wide circuit breaker. A contract that
fills, settles or lends against the stock should stop when the stock does. This package has two halves:

- `ts/guard.ts`: parses Nasdaq Trader's public trade-halts RSS
  (`https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts`, no key) and decides each token's state. It
  covers halts, market-wide circuit breakers, bad prints against a reference price, issuer pauses and
  regular-hours sessions, with NYSE's holidays and 13:00 ET early closes for 2026-2028 (outside those
  years every day reads closed). A `core-hours` session also closes the first 15 and last 25 minutes,
  when US Limit Up-Limit Down bands are doubled.
- `MarketStateRegistry.sol`: an updater (the guard) writes that state onchain. `MarketStateCheck.requireOpen`
  reverts when a token is halted, before its resumption time, or when the guard has not confirmed its
  state within `maxStateAge`. A guard that goes quiet therefore stops trading. It does not let trading run
  unchecked.

The parser throws on anything that is not a complete feed, so "no data" is never read as "no halts".
That covers a maintenance page, a truncated body, an item count that does not match, a row with no
usable symbol, and a missing publication date. A row whose times cannot be read keeps its symbol halted.

## Use it

Solidity (Foundry):

```sh
forge install fabrknt/market-state@v0.4.0
```

```solidity
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {MarketStateCheck} from "market-state/MarketStateCheck.sol";

MarketStateCheck.requireOpen(registry, token, 300); // reverts MarketHalted / MarketStateStale / NotYetResumed
```

TypeScript (the guard):

```sh
npm install github:fabrknt/market-state#v0.4.0
```

To upgrade, install the new tag by name again (`npm install github:fabrknt/market-state#v0.4.0`). Editing
the tag in package.json and running a bare `npm install` can keep the old commit in package-lock.json and
node_modules. Check `node_modules/@fabrknt/market-state/package.json` for the version you expect.

```ts
import { NASDAQ_HALTS_URL, parseNasdaqFeed, marketStateFor, GUARD_FEED_MAX_AGE_SECONDS, type GuardPolicy } from "@fabrknt/market-state";

const policy: GuardPolicy = { market: { haltSync: true, badPrintBandBps: 0, session: "regular-hours", maxStateAgeSeconds: 300 } };
const feed = parseNasdaqFeed(await (await fetch(NASDAQ_HALTS_URL)).text());
const now = Math.floor(Date.now() / 1000);
const s = marketStateFor(policy, "GME", now, { halts: feed.halts, fetchedAt: feed.publishedAt }, GUARD_FEED_MAX_AGE_SECONDS);
// s = { halted, reason, resumeAfter, detail } -> registry.setState(token, s.halted, s.reason, s.resumeAfter)
```

`reason` codes are the same on both sides: 1 primary halt, 2 bad print, 3 session closed, 4 corporate
action, 5 manual, 6 issuer paused.

## Trust

The updater key decides what is halted. A malicious or compromised updater can mark a halted stock as
open. A stopped updater only closes markets. Run the updater yourself, and show users who holds the key.

## Tests

```sh
forge test          # registry and requireOpen: 9 tests
npm install && npm test   # feed parsing, halts, circuit breakers, bad prints, sessions, DST: 16 tests
```

`fixtures/nasdaq-tradehalts.xml` is the live feed as captured on 2026-11-03.

## Status

- `v0.1.0`: first release. It was extracted from one of our private projects, where this code went through
  repeated independent reviews. Unaudited.
- `v0.2.0`: exchange holidays and early closes (`regularSession`, `EXCHANGE_HOLIDAYS`, `EARLY_CLOSES`), from
  NYSE Group's 2026-2028 calendar (announced 2025-12-23). A year outside the calendar reads closed, so a
  stale calendar fails closed rather than open. Found while using it in Summon: Thanksgiving (2026-11-26)
  read as open, and 11-27 as open until 16:00.
- `v0.3.0`: the `core-hours` session (09:45-15:35 ET, 09:45-12:35 on early closes). Summon does not fill
  while LULD bands are doubled.
- `v0.4.0`: a `session` name it does not know reads closed (`SESSION_CLOSED`, detail `unknown session "..."`),
  and the type admits only `"regular-hours" | "core-hours" | "always"` (#1). Before, any other value meant no
  session check, so the market read open around the clock. Found while using it in Summon: its `node_modules`
  still held a v0.2.0 build, which did not know `core-hours`, and the market read open after the close.
- `v0.4.1` (unreleased): `setState` emits `MarketStateChanged` only when the stored state changes. With
  `halted = false` and a non-zero reason, the reason is stored as `NONE` but was compared as sent, so every
  call emitted.

## Used in

- [Summon](https://github.com/psyto/summon-stocks): backer-funded rounds for tokenized stocks on Base
  Sepolia. Every auction start and fill calls `requireOpen` for the stock, and its tests cover a halted
  stock, a quiet guard and a fill before the resumption time. Pins `v0.4.0`.
- The private project this was extracted from now depends on `v0.1.0` as well, instead of keeping its
  own copy.

## License

Apache-2.0
