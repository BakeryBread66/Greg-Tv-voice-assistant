// Market tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { CHANNELS } from "../channels.js";
import { getStocks, spokenPercent } from "../stocks.js";

const MARKET_NOTE = "Report these figures. Do not say whether anything is a good or bad investment.";
const SESSION_WORDS = {
  open: "the market is open",
  closed: "the market is closed — these are the last closing prices",
  pre: "pre-market trading",
  post: "after-hours trading",
  unknown: "session state unknown",
};

export const market = [
  {
    // The counterpart to channel 8, and it exists for the same reason
    // whats_playing exists beside channel 2: without it, "what is the NASDAQ at"
    // matched the channel alias and Greg SWITCHED CHANNELS instead of answering.
    // Measured, on the run that added the channel. Asking is not switching.
    name: "get_market",
    description:
      "Get the current NASDAQ Composite level and the share prices on the user's watchlist. Use for 'what's the NASDAQ at', 'how are the markets doing', 'what is Apple trading at'. Reports numbers only — it is not advice.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "One ticker, e.g. 'AAPL', if they asked about a single company. Leave empty for the whole board.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    try {
      const board = await getStocks(ctx.config);
      const wanted = String(input.symbol ?? "").trim().toUpperCase();
  
      // Preformatted STRINGS, not bare floats. Asked what Apple was trading
      // at, the model read `changePercent: 0.29` back as "two point nine
      // percent" — a tenfold error in a number the user might act on, from a
      // model doing arithmetic-shaped work on a float it only needed to say.
      // A string it can copy has nothing to get wrong.
      const row = (s) => ({
        symbol: s.symbol,
        name: s.name,
        price: s.price === null ? null : s.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        change: s.change === null ? null : `${s.change >= 0 ? "+" : "-"}${Math.abs(s.change).toFixed(2)}`,
        changePercent: s.changePercent === null ? null : spokenPercent(s.changePercent),
      });
  
      // Naming one company should answer about that company, not read out the
      // whole board and leave them to find it.
      if (wanted) {
        const found = [board.index, ...board.rows].find(
          (s) => s && !s.failed && (s.symbol === wanted || s.symbol === `^${wanted}`)
        );
        if (!found) {
          return {
            error: `${wanted} is not on the board. It shows the NASDAQ Composite and ${board.rows.map((r) => r.symbol).join(", ")}.`,
          };
        }
        return { ...row(found), session: SESSION_WORDS[board.session] ?? board.session, asOf: found.at, note: MARKET_NOTE };
      }
  
      return {
        index: board.index ? row(board.index) : null,
        watchlist: board.rows.filter((r) => !r.failed).map(row),
        // Spelled out, because a price with no session beside it reads as live
        // when it is last Friday's close.
        session: SESSION_WORDS[board.session] ?? board.session,
        asOf: board.index?.at ?? null,
        note: MARKET_NOTE,
      };
    } catch (err) {
      return { error: `The market feed did not answer: ${err.message}` };
    }
    },
  },
];
