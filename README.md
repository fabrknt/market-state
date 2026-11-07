# market-state

**Halt and session state for tokenized stocks, which readers fail closed on.**

A tokenized stock can trade onchain while its primary listing is halted. The usual cases are a news
pending halt, a volatility pause, an SEC suspension, or a market-wide circuit breaker. A contract that
fills, settles or lends against the stock should stop when the stock does. This package has two halves:

- `ts/guard.ts`: parses Nasdaq Trader's public trade-halts RSS
  (`https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts`, no key) and decides each token's state. It
  covers halts, market-wide circuit breakers, bad prints against a reference price, issuer pauses and
  regular-hours sessions.
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
forge install fabrknt/market-state@v0.1.0
```

```solidity
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {MarketStateCheck} from "market-state/MarketStateCheck.sol";

MarketStateCheck.requireOpen(registry, token, 300); // reverts MarketHalted / MarketStateStale / NotYetResumed
```

TypeScript (the guard):

```sh
npm install github:fabrknt/market-state#v0.1.0
```

```ts
import { NASDAQ_HALTS_URL, parseNasdaqFeed, marketStateFor, GUARD_FEED_MAX_AGE_SECONDS } from "@fabrknt/market-state";

const policy = { market: { haltSync: true, badPrintBandBps: 0, session: "regular-hours", maxStateAgeSeconds: 300 } };
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
forge test          # registry and requireOpen: 8 tests
npm install && npm test   # feed parsing, halts, circuit breakers, bad prints, sessions, DST: 12 tests
```

`fixtures/nasdaq-tradehalts.xml` is the live feed as captured on 2026-11-03.

## Status

- `v0.1.0`: first release. It was extracted from one of our private projects, where this code went through
  repeated independent reviews. Unaudited.
- Not done: exchange holidays (`inRegularSession` knows weekdays and 09:30–16:00 ET only).

## Used in

- Next: Summon (`psyto/summon-stocks`, private for now), whose rounds will fill only when
  `requireOpen` passes for the stock. Listed here once it does.

## License

Apache-2.0
