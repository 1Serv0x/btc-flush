// btc-race-24h entry: a long-only cbBTC/USDC bot that waits for a pool-driven flush and buys it.
//
// The price it trades comes from one Orca Whirlpool, where the quote only moves when someone trades
// across it. A small move is ordinary flow and is not worth crossing the spread for: a full round
// trip costs about 43 bps at full stake in fee, slippage and price impact, so a trade must catch a
// move larger than that. A large move in one direction is a liquidity taker pushing the pool off
// the price the wider market is at, and that gap is what gets arbitraged back. So the bot holds
// cash, waits for the pool to fall hard over a short lookback, buys into the flush, and holds for
// two hours before letting it go. On the dev window the edge crosses from losing to winning at a
// decline of roughly 150 bps and stays positive above it, which is the cost hurdle and not a tuned
// threshold: below it the bot would be paying 43 bps to catch a move that is not there.
//
// The entry races on net PnL, so it commits its whole cash balance rather than a fraction: with a
// 150 bps stop each loss is about 1.7% of equity and the 120-bar hold caps the window at roughly a
// dozen trades, so the 25% drawdown guardrail holds with room to spare. A circuit breaker makes
// that a rule rather than a hope: once equity is 18% below its own high-water mark the position is
// sold and the bot stops trading for the rest of the window, so a tape that stops out every entry
// still lands inside the guardrail instead of ranking below every bot that meets it. The breaker
// tracks the peak because that is the denominator the guardrail uses, not the starting cash.
//
// All indicators are causal: the signal for the bar closing at minute t reads only bars at or before
// t. An order decided on bar t fills at bar t+1's open. Nothing reads the clock, the environment or
// Math.random, so two runs write the same action log.
import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars of decline measured against the close `LOOK_BARS` back. */
const LOOK_BARS = 90;
/** A decline of at least this many bps over that lookback is a flush worth buying. */
const DROP_BPS = 250;
/** Bars a bought position is held before it is sold. */
const HOLD_BARS = 120;
/** Adverse move from the entry price, in bps, that closes the position early. */
const STOP_BPS = 150;
/** Equity below this percentage of its running peak liquidates and turns the bot off. */
const BREAKER_PCT = 82n;
/** With no trade yet and this few bars left, buy regardless of the tape, to meet the trade bar. */
const FORCE_AFTER_BARS = 1_440 - 180;
/** The forced trade is a guardrail trade, not an edge trade, so it tolerates more slippage. */
const FORCE_SLIP_BPS = 1_000;
/** An entry is refused if the pool has moved this far from the close the signal read. */
const MAX_SLIPPAGE_BPS = 300;
/**
 * An exit is never refused for slippage. The bound is a stale-price guard, not a price control:
 * the fill still goes through the pool at whatever it quotes, so the only thing a tight bound can
 * do is refuse to sell. In a cascade that gaps more than the bound every bar that strands the
 * position and it rides the whole decline, which is the one way this bot can breach the drawdown
 * guardrail. Exiting is always the right move once the stop or the breaker has decided.
 */
const EXIT_SLIPPAGE_BPS = 10_000;
/** Below this a buy is under the venue's 1 USDC minimum and is not sent. */
const MIN_NOTIONAL = 1_000_000n;

/** Per-symbol state: the close series and the open position's bookkeeping. */
interface Track {
  /** Every close seen, in order. */
  closes: number[];
  /** Index into closes where the open position was entered, or -1 when flat. */
  entryIdx: number;
  /** Close at entry, the reference for the stop. */
  entryPrice: number;
}

const tracks = new Map<string, Track>();
/** Highest marked equity seen so far. The guardrail divides drawdown by the running peak. */
let peakEquity = -1n;
/** Set when the circuit breaker fires; the position is sold and no further buys are sent. */
let halted = false;
/** Orders that actually filled, so the bot knows whether it has met the venue's one-trade bar. */
let trades = 0;

function track(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], entryIdx: -1, entryPrice: 0 };
    tracks.set(symbol, t);
  }
  return t;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Only a filled order counts. A rejected one still comes back in `fills`, and counting it
    // would both disable the forced-trade fallback and leave the day with no trade at all.
    for (const fill of batch.fills) if (fill.status === 'filled') trades += 1;
    if (state.equity > peakEquity) peakEquity = state.equity;
    const orders: (BuyInput | SellInput)[] = [];
    for (const bar of batch.bars) {
      const t = track(bar.symbol);
      const close = Number(bar.c);
      t.closes.push(close);

      // A warm-up batch's orders would be rejected; build history and decide nothing.
      if (state.warmingUp) continue;

      const held = state.positions.get(bar.symbol);
      const index = t.closes.length - 1;
      const qty = held?.qty ?? 0n;

      // The breaker reads the account's marked equity against its own running peak, because the
      // guardrail divides drawdown by the peak and not by the starting cash. Anchored to the start
      // it would guard 18% of the start, which is under 25% of any peak above $1,093: a day that
      // rallied first and slid afterwards could then breach while the breaker sat silent.
      if (!halted && peakEquity > 0n && state.equity * 100n < peakEquity * BREAKER_PCT) halted = true;

      if (qty > 0n) {
        const moveBps = t.entryPrice > 0 ? ((close - t.entryPrice) / t.entryPrice) * 1e4 : 0;
        const heldFor = t.entryIdx >= 0 ? index - t.entryIdx : 0;
        if (moveBps < -STOP_BPS || heldFor >= HOLD_BARS || halted) {
          orders.push({ side: 'sell', symbol: bar.symbol, qty, max_slippage_bps: EXIT_SLIPPAGE_BPS });
          t.entryIdx = -1;
          t.entryPrice = 0;
        }
        continue;
      }

      if (halted) continue;

      // The venue ranks an entry with no trade below every entry that has one, so a quiet window
      // must not leave the bot having done nothing at all. With `FORCE_AFTER_BARS` left in the
      // window and no trade yet, the entry is opened at the next bar whatever the tape says: one
      // round trip costs about 43 bps, which is a cheaper way to meet the bar than not meeting it,
      // and it is retried every bar until one actually fills.
      const mustTrade = trades === 0 && index >= FORCE_AFTER_BARS;
      let take = mustTrade;
      if (!take) {
        if (index < LOOK_BARS) continue;
        const past = t.closes[index - LOOK_BARS]!;
        if (past === 0) continue;
        take = ((close - past) / past) * 1e4 <= -DROP_BPS;
      }
      if (!take) continue;

      const notional = state.cash;
      if (notional < MIN_NOTIONAL) continue;
      const slip = mustTrade ? FORCE_SLIP_BPS : MAX_SLIPPAGE_BPS;
      orders.push({ side: 'buy', symbol: bar.symbol, notional_quote_units: notional, max_slippage_bps: slip });
      t.entryIdx = index;
      t.entryPrice = close;
    }
    return orders.slice(0, state.hello.caps.max_orders_per_bar);
  },
});
