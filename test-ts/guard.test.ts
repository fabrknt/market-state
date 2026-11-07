import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARKET_REASON, easternToUnix, evaluateMarket, inRegularSession, marketStateFor, regularSession, parseNasdaqFeed, parseNasdaqHalts, type GuardPolicy } from "../ts/index.js";

// Halts from the feed, a 10% bad-print band, trading around the clock, feeds up to 5 minutes old.
const policy: GuardPolicy = {
  market: { haltSync: true, issuerSync: false, badPrintBandBps: 1000, session: "always", maxStateAgeSeconds: 300 },
};
const NOW = 1_800_000_000;

const OK_PX = { referencePrice: 200, venuePrice: 201 };

describe("guard", () => {
  const xml = readFileSync("fixtures/nasdaq-tradehalts.xml", "utf8");
  const halts = parseNasdaqHalts(xml);

  it("parses the live Nasdaq halts feed captured on 2026-11-03", () => {
    expect(halts.length).toBe(15);
    const ufg = halts.find((h) => h.symbol === "UFG")!;
    expect(ufg.reasonCode).toBe("T1");
    // 11/02/2026 19:50 ET is after the DST switch (EST, UTC-5)
    expect(ufg.haltAt).toBe(Date.UTC(2026, 10, 3, 0, 50) / 1000);
  });

  it("an unreadable halt row keeps its symbol halted", () => {
    const broken = xml.replace(/<ndaq:HaltTime>[^<]*<\/ndaq:HaltTime>/, "<ndaq:HaltTime>pending</ndaq:HaltTime>");
    const parsed = parseNasdaqHalts(broken);
    const row = parsed.find((x) => x.reasonCode === "UNPARSEABLE")!;
    expect(row.symbol).toBe("UFG");
    expect(evaluateMarket(policy, { symbol: "UFG", now: NOW, halts: parsed, ...OK_PX }).reason).toBe(MARKET_REASON.PRIMARY_HALT);
    // a resumption before the halt is malformed too
    const backwards = xml.replace(
      /<ndaq:ResumptionDate \/>\s*<ndaq:ResumptionQuoteTime \/>\s*<ndaq:ResumptionTradeTime \/>/,
      "<ndaq:ResumptionDate>11/02/2026</ndaq:ResumptionDate><ndaq:ResumptionQuoteTime /><ndaq:ResumptionTradeTime>19:00:00</ndaq:ResumptionTradeTime>",
    );
    const ufg = parseNasdaqHalts(backwards).find((x) => x.symbol === "UFG")!;
    expect(ufg).toMatchObject({ reasonCode: "UNPARSEABLE", resumeTradeAt: null });
    expect(() => easternToUnix("11/02/2026", "")).toThrow();
    expect(() => easternToUnix("13/02/2026", "10:00:00")).toThrow();
  });

  it("the feed carries its own publication time; without one it is refused", () => {
    expect(parseNasdaqFeed(xml).publishedAt).toBe(Date.UTC(2026, 10, 3, 6, 34, 19) / 1000);
    expect(() => parseNasdaqFeed(xml.replace(/<pubDate>Tue[^<]*<\/pubDate>/, ""))).toThrow(/pubDate/);
  });

  it("a non-feed or truncated response throws instead of reading as no halts", () => {
    expect(() => parseNasdaqHalts("<html>503 Service Unavailable</html>")).toThrow(/not a Nasdaq halts RSS/);
    expect(() => parseNasdaqHalts("")).toThrow();
    const truncated = xml.replace(/<item>[\s\S]*?<\/item>/, "");
    expect(() => parseNasdaqHalts(truncated)).toThrow(/lists 15 items but contains 14/);
    // cut right after <ndaq:numItems>, and at every 500th byte of the captured feed
    const cut = xml.indexOf("<ndaq:numItems>") + "<ndaq:numItems>".length;
    expect(() => parseNasdaqHalts(xml.slice(0, cut))).toThrow();
    for (let i = 1; i < xml.length - 10; i += 500) expect(() => parseNasdaqHalts(xml.slice(0, i))).toThrow();
    expect(parseNasdaqHalts(xml)).toHaveLength(15);
    // a row with no symbol cannot be attributed, so the feed is rejected
    expect(() => parseNasdaqHalts(xml.replace(/<ndaq:IssueSymbol>[^<]*<\/ndaq:IssueSymbol>/, "<ndaq:IssueSymbol/>"))).toThrow(/unusable symbol/);
  });

  it("converts Eastern time across daylight saving", () => {
    expect(easternToUnix("07/01/2026", "09:30:00.000")).toBe(Date.UTC(2026, 6, 1, 13, 30) / 1000); // EDT
    expect(easternToUnix("12/01/2026", "09:30:00.000")).toBe(Date.UTC(2026, 11, 1, 14, 30) / 1000); // EST
  });

  it("a market-wide halt row stops every symbol even when its times are unreadable", () => {
    for (const code of ["MWC0", "MWC1", "MWC2", "MWC3"]) {
      const mw = xml
        .replace(/<ndaq:ReasonCode>[^<]*<\/ndaq:ReasonCode>/, `<ndaq:ReasonCode>${code}</ndaq:ReasonCode>`)
        .replace(/<ndaq:HaltTime>[^<]*<\/ndaq:HaltTime>/, "<ndaq:HaltTime>pending</ndaq:HaltTime>");
      const parsed = parseNasdaqHalts(mw);
      expect(parsed.find((h) => h.marketWide)?.reasonCode).toBe("UNPARSEABLE");
      expect(evaluateMarket(policy, { symbol: "NVDA", now: NOW, halts: parsed, ...OK_PX }).reason).toBe(MARKET_REASON.PRIMARY_HALT);
    }
  });

  it("a market-wide circuit breaker stops every symbol", () => {
    const mwcb = { symbol: "SPY", market: "NASDAQ", reasonCode: "MWC1", haltAt: NOW - 60, resumeTradeAt: NOW + 900 };
    expect(evaluateMarket(policy, { symbol: "NVDA", now: NOW, halts: [mwcb], ...OK_PX }).reason).toBe(MARKET_REASON.PRIMARY_HALT);
    expect(evaluateMarket(policy, { symbol: "NVDA", now: NOW + 901, halts: [mwcb], ...OK_PX }).halted).toBe(false);
    // an ordinary single-stock halt does not spread
    expect(evaluateMarket(policy, { symbol: "NVDA", now: NOW, halts: [{ ...mwcb, reasonCode: "T1" }], ...OK_PX }).halted).toBe(false);
  });

  it("a halted symbol stops; a resumed one opens", () => {
    const h = halts.find((x) => x.resumeTradeAt === null)!;
    const s = evaluateMarket(policy, { symbol: h.symbol, now: h.haltAt + 60, halts });
    expect(s).toMatchObject({ halted: true, reason: MARKET_REASON.PRIMARY_HALT });
    const resumed = [{ ...h, resumeTradeAt: h.haltAt + 300 }];
    expect(evaluateMarket(policy, { symbol: h.symbol, now: h.haltAt + 301, halts: resumed, ...OK_PX }).halted).toBe(false);
  });

  it("freezes on a bad print outside the band (SK Hynix 2026-07-28 was ~18%)", () => {
    const s = evaluateMarket(policy, { symbol: "SKHY", now: NOW, halts: [], referencePrice: 100, venuePrice: 82 });
    expect(s).toMatchObject({ halted: true, reason: MARKET_REASON.BAD_PRINT });
    expect(evaluateMarket(policy, { symbol: "SKHY", now: NOW, halts: [], referencePrice: 100, venuePrice: 95 }).halted).toBe(false);
    // a zero or missing price must freeze, not pass
    for (const [referencePrice, venuePrice] of [[100, 0], [0, 100], [100, undefined], [Number.NaN, 100]] as const) {
      expect(evaluateMarket(policy, { symbol: "SKHY", now: NOW, halts: [], referencePrice, venuePrice }).reason).toBe(MARKET_REASON.BAD_PRINT);
    }
    // with a band configured, no prices at all freezes too
    expect(evaluateMarket(policy, { symbol: "SKHY", now: NOW, halts: [] }).reason).toBe(MARKET_REASON.BAD_PRINT);
    const noBand = { ...policy, market: { ...policy.market, badPrintBandBps: 0 } };
    expect(evaluateMarket(noBand, { symbol: "SKHY", now: NOW, halts: [] }).halted).toBe(false);
  });

  it("regular-hours sessions close on weekends", () => {
    const rh = { ...policy, market: { ...policy.market, session: "regular-hours" as const } };
    const saturdayNoonEt = easternToUnix("11/07/2026", "12:00:00");
    expect(inRegularSession(saturdayNoonEt)).toBe(false);
    expect(evaluateMarket(rh, { symbol: "NVDA", now: saturdayNoonEt, halts: [], ...OK_PX }).reason).toBe(MARKET_REASON.SESSION_CLOSED);
    expect(evaluateMarket(policy, { symbol: "NVDA", now: saturdayNoonEt, halts: [], ...OK_PX }).halted).toBe(false);
  });
  it("regular-hours sessions close on exchange holidays and at 13:00 on early closes", () => {
    const rh = { ...policy, market: { ...policy.market, session: "regular-hours" as const } };
    // Thanksgiving 2026: a Thursday, closed all day
    const thanksgiving = easternToUnix("11/26/2026", "12:00:00");
    expect(inRegularSession(thanksgiving)).toBe(false);
    expect(evaluateMarket(rh, { symbol: "NVDA", now: thanksgiving, halts: [], ...OK_PX }).detail).toBe("exchange holiday 2026-11-26");
    // the day after: open in the morning, closed from 13:00
    expect(inRegularSession(easternToUnix("11/27/2026", "12:59:00"))).toBe(true);
    expect(inRegularSession(easternToUnix("11/27/2026", "13:00:00"))).toBe(false);
    expect(evaluateMarket(rh, { symbol: "NVDA", now: easternToUnix("11/27/2026", "14:00:00"), halts: [], ...OK_PX }).detail).toBe(
      "outside 09:30-13:00 ET (early close)",
    );
    // an ordinary weekday keeps 09:30-16:00
    expect(inRegularSession(easternToUnix("11/09/2026", "09:29:00"))).toBe(false);
    expect(inRegularSession(easternToUnix("11/09/2026", "09:30:00"))).toBe(true);
    expect(inRegularSession(easternToUnix("11/09/2026", "15:59:00"))).toBe(true);
    expect(inRegularSession(easternToUnix("11/09/2026", "16:00:00"))).toBe(false);
    // observed holidays: Juneteenth 2027 falls on a Saturday and is observed Friday 6/18
    expect(inRegularSession(easternToUnix("06/18/2027", "12:00:00"))).toBe(false);
    // 2028 observes no New Year's Day (it falls on a Saturday); Monday 1/3 trades
    expect(inRegularSession(easternToUnix("01/03/2028", "12:00:00"))).toBe(true);
  });
  it("core-hours sessions also close while LULD bands are doubled", () => {
    const core = { ...policy, market: { ...policy.market, session: "core-hours" as const } };
    const at = (d: string, t: string) => evaluateMarket(core, { symbol: "NVDA", now: easternToUnix(d, t), halts: [], ...OK_PX });
    expect(at("11/09/2026", "09:44:00").reason).toBe(MARKET_REASON.SESSION_CLOSED);
    expect(at("11/09/2026", "09:45:00").halted).toBe(false);
    expect(at("11/09/2026", "15:34:00").halted).toBe(false);
    expect(at("11/09/2026", "15:35:00").detail).toMatch(/LULD bands doubled/);
    // on an early close the last 25 minutes are 12:35-13:00
    expect(at("11/27/2026", "12:34:00").halted).toBe(false);
    expect(at("11/27/2026", "12:35:00").halted).toBe(true);
    // regular-hours keeps the edges open
    expect(regularSession(easternToUnix("11/09/2026", "09:31:00")).open).toBe(true);
  });
  it("a year the calendar does not cover reads closed", () => {
    const mondayNoon2029 = easternToUnix("01/08/2029", "12:00:00");
    expect(regularSession(mondayNoon2029)).toEqual({ open: false, detail: "no exchange calendar for 2029" });
  });
  it("impossible calendar dates are malformed, not rolled over", () => {
    expect(() => easternToUnix("11/31/2026", "09:30:00")).toThrow(/bad eastern date/);
    expect(() => easternToUnix("02/29/2026", "09:30:00")).toThrow(/bad eastern date/);
    expect(easternToUnix("02/28/2026", "09:30:00")).toBe(Date.UTC(2026, 1, 28, 14, 30) / 1000);
    // 02:30 on the spring-forward day does not exist in New York
    expect(() => easternToUnix("03/08/2026", "02:30:00")).toThrow(/nonexistent/);
    expect(easternToUnix("03/08/2026", "03:30:00")).toBe(Date.UTC(2026, 2, 8, 7, 30) / 1000); // EDT
    expect(easternToUnix("11/01/2026", "01:30:00")).toBeGreaterThan(0); // fall-back hour exists (twice)
  });
});

describe("marketStateFor", () => {
  it("a missing, stale or future-dated feed counts as halted", () => {
    expect(marketStateFor(policy, "NVDA", NOW, undefined).halted).toBe(true);
    expect(marketStateFor(policy, "NVDA", NOW, { halts: [], fetchedAt: NOW - 301 }).detail).toBe("halts feed is stale");
    expect(marketStateFor(policy, "NVDA", NOW, { halts: [], fetchedAt: NOW + 31 }).halted).toBe(true);
    expect(marketStateFor(policy, "NVDA", NOW, { halts: [], fetchedAt: NOW - 10 }).halted).toBe(false);
    // a tighter limit for guards that write on chain
    expect(marketStateFor(policy, "NVDA", NOW, { halts: [], fetchedAt: NOW - 200 }, 120).halted).toBe(true);
  });
});
