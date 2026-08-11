// The NASDAQ, and a handful of the stocks on it.
//
// Yahoo's chart endpoint, keyless: `/v8/finance/chart/{symbol}` gives the last
// price, the previous close, the day's range, the 52-week range and an intraday
// series, all in one small request. Their batch quote endpoint (`/v7/quote`) is
// **401 now** — locked down — so this is one request per symbol, which is why
// the watchlist is capped and asked for at the leanest interval available.
//
// **This channel reports numbers and nothing else.** No signals, no "up on the
// day so it's a good time", no commentary of any kind — not in the data, not in
// the renderer, not in the channel description the model can read. Greg is not
// anybody's financial adviser and a television that starts implying otherwise is
// a worse television. It is a share price the way the weather channel is a
// temperature: a reading, with the time it was taken.
//
// The other half of that honesty is the market being SHUT. It is closed more
// hours of the week than it is open, and a price with no session state next to
// it reads as live when it is Friday's close.

const HOST = "https://query1.finance.yahoo.com/v8/finance/chart";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// The headline instrument. "NASDAQ" on its own means the Composite.
const INDEX = "^IXIC";

// Large NASDAQ-listed names, purely as a starting point — `config.stocks.symbols`
// replaces this wholesale. Deliberately NOT presented anywhere as a selection,
// recommendation or portfolio; it is a default list of tickers to display.
const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA"];

// One request per symbol, so this is the difference between a polite caller and
// a rude one. Twelve is already more rows than the screen can show legibly.
const MAX_SYMBOLS = 12;

async function fetchSymbol(symbol, { series = false } = {}) {
  // A 1-day/1-day request still carries the whole meta block and is ~1.2 KB;
  // only the instrument that gets a chart drawn needs the 5-minute series.
  const range = series ? "range=1d&interval=5m" : "range=1d&interval=1d";
  const res = await fetch(`${HOST}/${encodeURIComponent(symbol)}?${range}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const err = new Error(`the market feed returned ${res.status} for ${symbol}`);
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`no data for ${symbol}`);

  const m = result.meta;
  // `chartPreviousClose` is the close of the session BEFORE the one shown, which
  // is what every "change on the day" figure is measured against. Falling back
  // to `previousClose` rather than to the first tick of the series: on a day the
  // market gapped at the open those are different numbers, and using the wrong
  // one puts the change out by the size of the gap.
  const previous = m.chartPreviousClose ?? m.previousClose ?? null;
  const price = m.regularMarketPrice ?? null;

  return {
    symbol: m.symbol ?? symbol,
    name: m.shortName || m.longName || symbol,
    currency: m.currency ?? "USD",
    price,
    previousClose: previous,
    change: price !== null && previous !== null ? price - previous : null,
    changePercent: price !== null && previous ? ((price - previous) / previous) * 100 : null,
    dayHigh: m.regularMarketDayHigh ?? null,
    dayLow: m.regularMarketDayLow ?? null,
    yearHigh: m.fiftyTwoWeekHigh ?? null,
    yearLow: m.fiftyTwoWeekLow ?? null,
    // The moment the price was struck, not the moment we asked. On a closed
    // market those are days apart.
    at: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    timezone: m.exchangeTimezoneName ?? "America/New_York",
    session: sessionState(m.currentTradingPeriod),
    series: series ? seriesFrom(result) : null,
  };
}

/**
 * Where the clock is relative to the exchange's own session windows.
 *
 * Read off the feed's `currentTradingPeriod` rather than computed from a
 * timezone and a pair of hard-coded hours — that would need a US market holiday
 * calendar to be right, and would be quietly wrong on Thanksgiving, Juneteenth
 * and every half-day after them.
 */
function sessionState(period) {
  if (!period?.regular) return "unknown";
  const now = Math.floor(Date.now() / 1000);
  if (now >= period.regular.start && now < period.regular.end) return "open";
  if (period.pre && now >= period.pre.start && now < period.pre.end) return "pre";
  if (period.post && now >= period.post.start && now < period.post.end) return "post";
  return "closed";
}

function seriesFrom(result) {
  const stamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    // A null close is a minute with no trade in it. Dropped rather than carried
    // forward or zeroed: a zero would drag the whole chart to the floor, and a
    // carried value would invent a trade that did not happen.
    if (typeof closes[i] === "number") points.push({ t: stamps[i], c: closes[i] });
  }
  return points;
}

/**
 * The index and the watchlist.
 *
 * Symbols are settled independently — one bad ticker in config.json must not
 * cost you the whole board, and a symbol that has been delisted or mistyped
 * should say so in its own row rather than blanking the channel.
 */
export async function getStocks(config = {}) {
  const wanted = (config.stocks?.symbols ?? DEFAULT_SYMBOLS)
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_SYMBOLS);

  const [index, ...rest] = await Promise.allSettled([
    fetchSymbol(config.stocks?.index ?? INDEX, { series: true }),
    ...wanted.map((symbol) => fetchSymbol(symbol)),
  ]);

  if (index.status === "rejected" && rest.every((r) => r.status === "rejected")) {
    throw new Error(index.reason?.message ?? "the market feed did not answer");
  }

  const headline = index.status === "fulfilled" ? index.value : null;

  return {
    index: headline,
    // The session comes off the index, which is the instrument the header is
    // about. A per-row session would be the same value repeated six times.
    session: headline?.session ?? "unknown",
    rows: rest.map((r, i) =>
      r.status === "fulfilled" ? r.value : { symbol: wanted[i], name: wanted[i], failed: true }
    ),
    // Longer between polls when nothing can move. The registry's interval is
    // sized for an open market; outside it, asking every minute for a number
    // that changed last Friday is just noise on somebody else's server.
    preferredPollMs: headline?.session === "open" ? 60000 : 900000,
    stale: false,
  };
}

// Words that make a question a request for a RECOMMENDATION rather than for a
// number. Both halves have to be present: "buy" alone catches "should I buy a
// new laptop", and "stock" alone catches "how's the NASDAQ doing", which is a
// perfectly good question with a factual answer.
const ADVICE_VERB = /\b(should i|shall i|worth|good time|bad time|advise|advice|recommend|invest|buy|sell|short|dump|hold onto|get into|put money)\b/i;
const ADVICE_SUBJECT =
  /\b(stock|stocks|share|shares|equit|nasdaq|dow|s&p|sp500|index|ticker|crypto|bitcoin|etf|fund|funds|portfolio|market|markets|bond|bonds|option|options|invest)\w*\b/i;

// Naming a company IS naming the subject. "Should I buy Nvidia" contains no
// financial noun at all, and the first version of this gate stayed silent on it
// — which was the exact question that exposed the gap in the first place. Safe
// to include because BOTH halves must match: "tell me about Tesla's history"
// has no advice verb and still fires nothing.
const COMPANIES =
  /\b(nvidia|nvda|tesla|tsla|apple|aapl|microsoft|msft|amazon|amzn|alphabet|googl|google|meta|facebook|netflix|nflx|intel|intc|amd|broadcom|avgo|palantir|pltr|coinbase|coin|ethereum|dogecoin)\b/i;

/**
 * A paragraph for the system prompt, and ONLY when the user asked for advice.
 *
 * Gated on their own words, for the reason lib/selection.js records about
 * deixis: left in permanently it is ~40 tokens on every single turn to guard a
 * subject that comes up rarely, and this project counts per-turn overhead. No
 * trigger, no paragraph, nothing to get wrong.
 *
 * It exists because measuring found the gap rather than because it seemed
 * prudent. Asked "should I buy Nvidia", Greg searched the web and relayed an
 * analyst consensus of "Strong Buy" with a price target, flatly and with no
 * qualification — a recommendation in everything but authorship. Adding a
 * markets channel drives more traffic at exactly that question, so the guard
 * goes in with the channel rather than after it.
 *
 * Note what it does NOT do: it does not refuse, and it does not stop him
 * reporting what a source says. Reading out an analyst's rating as somebody
 * else's opinion is fine and useful. Presenting it as an answer to "should I"
 * is not.
 */
export function adviceRule(userText = "", config = {}) {
  const said = String(userText);
  if (!ADVICE_VERB.test(said)) return "";

  // Whatever is actually on their board counts as a subject too, so a watchlist
  // of tickers this file has never heard of is still covered.
  const watched = (config.stocks?.symbols ?? [])
    .map((s) => String(s).trim())
    .filter((s) => /^[A-Za-z.\-]{1,6}$/.test(s));
  const onTheBoard = watched.length && new RegExp(`\\b(${watched.join("|")})\\b`, "i").test(said);

  if (!ADVICE_SUBJECT.test(said) && !COMPANIES.test(said) && !onTheBoard) return "";

  return (
    `\n\nThe user is asking whether to buy, sell or hold something. You are NOT a financial adviser and must not ` +
    `tell them what to do with their money, however confident the sources sound. Say plainly, in one short sentence, ` +
    `that you cannot give investment advice. You MAY then report facts — the current price, what a named analyst or ` +
    `publication says — but attribute every opinion to whoever holds it and never state it as your own recommendation. ` +
    `Do not end with a suggestion, a lean, or a "but if it were me".`
  );
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = [
  "ten", "eleven", "twelve", "thirteen", "fourteen",
  "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];

/**
 * A percentage already written the way it should be SAID.
 *
 * "0.29%" was still being read aloud as "two point nine percent" one run in
 * three, even handed to the model as a preformatted string — a tenfold error in
 * a figure somebody might act on. A leading zero and two decimals is apparently
 * a hard thing for a small model to verbalise, and this is a spoken assistant,
 * so the last conversion step is the one to remove: give it the words and there
 * is nothing left to get wrong.
 *
 * Digits after the point are read individually, which is both how a percentage
 * is conventionally said and unambiguous — "point two nine" cannot be heard as
 * "twenty-nine" the way "point twenty-nine" can.
 *
 * Same lesson as speakable() spelling out UNCW, and as Brevity being sentence
 * counts rather than adjectives: give it something it can copy, not something
 * it has to convert.
 */
export function spokenPercent(percent) {
  const value = Math.abs(percent);
  const direction = percent > 0 ? "up" : percent < 0 ? "down" : "flat at";
  const [whole, decimals = "00"] = value.toFixed(2).split(".");

  // Small whole numbers spelled too — a percentage move is almost always under
  // twenty, and a mixed "0 point two nine" invites the model to renormalise the
  // whole thing, which is the habit being designed out. Anything larger is left
  // as digits; "one hundred and five" is not an improvement on "105".
  const n = Number(whole);
  const words = n < 10 ? ONES[n] : n < 20 ? TEENS[n - 10] : String(n);
  const spelled = decimals.split("").map((d) => ONES[Number(d)]).join(" ");
  return `${direction} ${words} point ${spelled} percent`;
}

// There was a describeStocks() here, and it was worse than dead — it was a
// trap. It formatted the move with `changePercent.toFixed(2)`, which is exactly
// the shape that made the model say "two point nine percent" for 0.29, one run
// in three. spokenPercent() above exists because preformatting the NUMBER never
// fixed it and handing over the WORDS did. Nothing called describeStocks;
// lib/tools/market.js uses spokenPercent. Anybody reaching for an obvious
// "sentence Greg can say" helper would have reintroduced a bug that took
// measurement to find, so it is gone rather than left lying about.
