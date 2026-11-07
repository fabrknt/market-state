import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * The settings the guard reads. Any object with this `market` shape works.
 * - haltSync: follow primary-exchange halts from the feed
 * - issuerSync: a missing or paused issuer state halts the token
 * - badPrintBandBps: freeze when venue and reference prices differ by more than this (0 = off)
 * - session: "regular-hours" closes outside 09:30-16:00 ET on weekdays; "always" does not
 * - maxStateAgeSeconds: the oldest halts feed that still counts as current
 */
export interface GuardPolicy {
  market: {
    haltSync: boolean;
    issuerSync?: boolean;
    badPrintBandBps: number;
    session: "regular-hours" | "always" | string;
    maxStateAgeSeconds: number;
  };
}

/** Reason codes; must match MarketStateRegistry.sol. */
export const MARKET_REASON = {
  NONE: 0,
  PRIMARY_HALT: 1,
  BAD_PRINT: 2,
  SESSION_CLOSED: 3,
  CORPORATE_ACTION: 4,
  MANUAL: 5,
  ISSUER_PAUSED: 6,
} as const;

/** Nasdaq Trader's public halts feed (RSS), the source parseNasdaqFeed reads. */
export const NASDAQ_HALTS_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";

/** The oldest feed a guard should write on chain from: halt data on chain is then at most this plus the reader's max state age old. */
export const GUARD_FEED_MAX_AGE_SECONDS = 120;

/** How far a feed's own timestamp may run ahead of `now` (the feed's clock against the host's or the chain's). */
export const MAX_FEED_SKEW_SECONDS = 30;

/** A halts feed stamped `fetchedAt` is usable at `now`: no older than maxStateAgeSeconds, and not dated further ahead than the skew allowance. */
export function feedFresh(s: GuardPolicy, fetchedAt: number, now: number): boolean {
  return fetchedAt - now <= MAX_FEED_SKEW_SECONDS && now - fetchedAt <= s.market.maxStateAgeSeconds;
}

export interface Halt {
  symbol: string;
  market: string;
  reasonCode: string; // e.g. T1 news pending, LUDP volatility pause, H10 SEC suspension
  haltAt: number; // unix seconds
  resumeTradeAt: number | null; // unix seconds, null while no resumption is published
  marketWide?: boolean; // a market-wide circuit breaker: stops every symbol
}

/** Market-wide circuit breaker halts (levels 1-3 and the next-day carry-over); they stop every symbol. */
const MARKET_WIDE = /^MWC[0-3]$/;

export interface NasdaqFeed {
  halts: Halt[];
  publishedAt: number; // unix seconds, the channel's pubDate: when Nasdaq generated this feed
}

/**
 * Parses Nasdaq Trader's public trade-halts RSS (https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts).
 * Throws on anything that is not a complete feed; callers must not refresh the heartbeat then.
 */
export function parseNasdaqHalts(xml: string): Halt[] {
  return parseNasdaqFeed(xml).halts;
}

/**
 * parseNasdaqHalts plus the feed's own publication time. Judge freshness by `publishedAt`, not by
 * when it was fetched: a cache or proxy can serve an old, complete feed. A missing or unreadable
 * pubDate throws.
 */
export function parseNasdaqFeed(xml: string): NasdaqFeed {
  const body = xml.replace(/^\uFEFF/, "");
  // a body cut off mid-transfer is not well-formed XML
  if (XMLValidator.validate(body) !== true) throw new Error("halts feed is not well-formed XML");
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(body);
  const channel = doc?.rss?.channel;
  // a maintenance page or truncated body is not "no halts": throw, write nothing, and let the
  // on-chain state go stale (MarketStateRegistry readers then fail closed)
  const numItems = String(channel?.["ndaq:numItems"] ?? "").trim();
  if (!channel || channel.title === undefined || !/^\d+$/.test(numItems)) {
    throw new Error("not a Nasdaq halts RSS document");
  }
  const raw = channel.item ?? [];
  const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw];
  if (items.length !== Number(numItems)) {
    throw new Error(`halts feed lists ${numItems} items but contains ${items.length}`);
  }
  const publishedAt = Math.floor(Date.parse(String(channel.pubDate ?? "")) / 1000);
  if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) throw new Error("halts feed has no readable pubDate");
  const halts = items.map((it) => {
    const str = (k: string) => String(it[`ndaq:${k}`] ?? "").trim();
    const symbol = str("IssueSymbol");
    // a halt we cannot attribute could be any listed stock: reject the whole feed (fail closed)
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,13}$/.test(symbol)) throw new Error(`halts feed row has unusable symbol "${symbol}"`);
    // decided before parsing times, so a malformed market-wide row still stops everything
    const marketWide = MARKET_WIDE.test(str("ReasonCode"));
    try {
      const resumeDate = str("ResumptionDate");
      const resumeTime = str("ResumptionTradeTime");
      const haltAt = easternToUnix(str("HaltDate"), str("HaltTime"));
      const resumeTradeAt = resumeDate && resumeTime ? easternToUnix(resumeDate, resumeTime) : null;
      if (resumeTradeAt !== null && resumeTradeAt <= haltAt) throw new Error("resumption not after halt");
      return { symbol, market: str("Market"), reasonCode: str("ReasonCode"), haltAt, resumeTradeAt, marketWide };
    } catch {
      // an unreadable row still names a halted symbol: keep it halted with no known resumption
      return { symbol, market: str("Market"), reasonCode: "UNPARSEABLE", haltAt: 0, resumeTradeAt: null, marketWide };
    }
  });
  return { halts, publishedAt };
}

/** "MM/DD/YYYY" + "HH:MM:SS(.mmm)" in America/New_York, DST included, to unix seconds. */
export function easternToUnix(date: string, time: string): number {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  const t = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(time);
  if (!d || !t) throw new Error(`bad eastern time ${date} ${time}`);
  const [mm, dd, yyyy] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, m, sec] = [Number(t[1]), Number(t[2]), Number(t[3])];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || h > 23 || m > 59 || sec > 59) throw new Error(`bad eastern time ${date} ${time}`);
  const asUtc = Date.UTC(yyyy, mm - 1, dd, h, m, Math.floor(sec));
  const back = new Date(asUtc);
  // Date.UTC rolls 11/31 over to 12/01; an impossible date is malformed, not a different day
  if (back.getUTCFullYear() !== yyyy || back.getUTCMonth() !== mm - 1 || back.getUTCDate() !== dd) {
    throw new Error(`bad eastern date ${date}`);
  }
  // offset of New York at that wall-clock time; checked twice to settle across a DST switch
  let guess = asUtc;
  for (let i = 0; i < 2; i++) guess = asUtc - offsetMs(guess);
  // a wall time skipped by the spring DST switch (e.g. 02:30) does not round-trip: malformed
  if (guess + offsetMs(guess) !== asUtc) throw new Error(`nonexistent eastern time ${date} ${time}`);
  return Math.floor(guess / 1000);
}

function offsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

export function activeHalt(halts: Halt[], symbol: string, now: number): Halt | undefined {
  return halts.find(
    (h) =>
      (h.symbol === symbol || h.marketWide === true || MARKET_WIDE.test(h.reasonCode)) &&
      h.haltAt <= now &&
      (h.resumeTradeAt === null || now < h.resumeTradeAt),
  );
}

export interface MarketInput {
  symbol: string;
  now: number;
  halts: Halt[];
  referencePrice?: number; // e.g. primary-exchange last sale
  venuePrice?: number; // price the pool would trade at
  /** The issuer's own state, for policies with market.issuerSync. */
  issuer?: { paused: boolean; tradable: boolean; detail?: string };
}

export interface MarketState {
  halted: boolean;
  reason: number;
  resumeAfter: number;
  detail: string;
}

/** Decides one token's state; the updater writes it to MarketStateRegistry. */
export function evaluateMarket(s: GuardPolicy, input: MarketInput): MarketState {
  if (s.market.haltSync) {
    const h = activeHalt(input.halts, input.symbol, input.now);
    if (h) {
      return {
        halted: true,
        reason: MARKET_REASON.PRIMARY_HALT,
        resumeAfter: h.resumeTradeAt ?? 0,
        detail: `${h.market} halt ${h.reasonCode} since ${new Date(h.haltAt * 1000).toISOString()}`,
      };
    }
  }
  if (s.market.issuerSync) {
    // no issuer state is not evidence the issuer lets the token trade
    const i = input.issuer;
    if (!i || i.paused || !i.tradable) {
      const detail = !i ? "no issuer state" : i.paused ? "issuer paused the token" : (i.detail ?? "issuer reports not tradable");
      return { halted: true, reason: MARKET_REASON.ISSUER_PAUSED, resumeAfter: 0, detail };
    }
  }
  const { referencePrice: ref, venuePrice: px } = input;
  // a configured band means prices are required: no prices is not evidence the market is fine
  if (s.market.badPrintBandBps > 0) {
    // a missing, zero or non-finite price on either side is not evidence the market is fine
    if (!(Number.isFinite(ref) && Number.isFinite(px) && ref! > 0 && px! > 0)) {
      return { halted: true, reason: MARKET_REASON.BAD_PRINT, resumeAfter: 0, detail: `unusable price: venue ${px}, reference ${ref}` };
    }
    const moveBps = (Math.abs(px! - ref!) / ref!) * 10_000;
    if (moveBps > s.market.badPrintBandBps) {
      return {
        halted: true,
        reason: MARKET_REASON.BAD_PRINT,
        resumeAfter: 0,
        detail: `venue ${px} vs reference ${ref}: ${moveBps.toFixed(0)} bps > band ${s.market.badPrintBandBps}`,
      };
    }
  }
  if (s.market.session === "regular-hours" && !inRegularSession(input.now)) {
    return { halted: true, reason: MARKET_REASON.SESSION_CLOSED, resumeAfter: 0, detail: "outside 09:30-16:00 ET" };
  }
  return { halted: false, reason: MARKET_REASON.NONE, resumeAfter: 0, detail: "open" };
}

/** Weekday 09:30-16:00 New York time. Exchange holidays are not modelled yet. */
export function inRegularSession(now: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(now * 1000));
  const wd = parts.find((p) => p.type === "weekday")?.value;
  const mins = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  return wd !== "Sat" && wd !== "Sun" && mins >= 570 && mins < 960;
}

/**
 * A policy's halt state for `symbol` from the halts feed alone: a missing feed, one older than the
 * policy's maxStateAgeSeconds, or one dated more than MAX_FEED_SKEW_SECONDS ahead counts as halted. Venue-price checks (bad
 * prints) and issuer state stay with the caller, who has the venue's quote and the issuer's data.
 * `maxFeedAgeSeconds` tightens the age limit: a guard writing on chain passes GUARD_FEED_MAX_AGE_SECONDS,
 * since the chain then honours the write for its own max state age on top of the feed's age.
 */
export function marketStateFor(s: GuardPolicy, symbol: string, now: number, h: { halts: Halt[]; fetchedAt: number } | undefined, maxFeedAgeSeconds?: number): MarketState {
  if (h === undefined) return { halted: true, reason: MARKET_REASON.PRIMARY_HALT, resumeAfter: 0, detail: "halts feed unavailable" };
  if (!feedFresh(s, h.fetchedAt, now) || (maxFeedAgeSeconds !== undefined && now - h.fetchedAt > maxFeedAgeSeconds)) {
    return { halted: true, reason: MARKET_REASON.PRIMARY_HALT, resumeAfter: 0, detail: "halts feed is stale" };
  }
  const haltsOnly: GuardPolicy = { ...s, market: { ...s.market, badPrintBandBps: 0, issuerSync: false } };
  return evaluateMarket(haltsOnly, { symbol, now, halts: h.halts });
}
