// Fast in-process simulator of the btc-race replay, matching harness/sim/bars/engine.ts:
// orders decided on bar t fill at bar t+1's open, with 4 bps fee, 2 bps slippage and
// constant-product price impact against that bar's o_depth. Used to sweep strategy params.
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const BPS = 10_000n;
const USDC_RAW = 1_000_000n;
const FEE_BPS = 4n;
const SLIP_BPS = 2n;
const START = 1_000_000_000n; // 1000 USDC
const PRICE_SCALE = 6;
const QTY_SCALE = 8;

export interface SimBar { t: number; o: bigint; h: bigint; l: bigint; c: bigint; od: bigint[]; cd: bigint[] }

export function loadBars(path: string): SimBar[] {
  const raw = gunzipSync(readFileSync(path)).toString().trim().split('\n');
  return raw.map((l) => {
    const b = JSON.parse(l);
    return { t: b.t, o: BigInt(b.o), h: BigInt(b.h), l: BigInt(b.l), c: BigInt(b.c), od: b.o_depth.map(BigInt), cd: b.c_depth.map(BigInt) };
  });
}

/** 1 + a/D for a one-hop pool: the price factor a trade worth `a` meets. */
function factor(amount: bigint, depth: bigint): { num: bigint; den: bigint } {
  // pool has quote reserve D and base reserve D/open; buy of `amount` quote:
  // avg price factor = 1 + amount/D (first order), integer-exact as (D + a) / D
  return { num: depth + amount, den: depth };
}

export interface FillResult { qty: bigint; spend: bigint; fee: bigint; price: bigint }

export function buyFill(notional: bigint, open: bigint, depth: bigint): FillResult {
  const spend = (notional * (BPS - FEE_BPS)) / BPS;
  const m = factor(spend, depth);
  const price = (open * (BPS + SLIP_BPS) * m.num) / (BPS * m.den);
  const qty = (spend * 10n ** BigInt(QTY_SCALE + PRICE_SCALE)) / (price * 10n ** BigInt(6));
  return { qty, spend, fee: notional - spend, price };
}

export function sellFill(qty: bigint, open: bigint, depth: bigint): { proceeds: bigint; fee: bigint; price: bigint; gross: bigint } {
  const value = (qty * open * 10n ** 6n) / 10n ** BigInt(QTY_SCALE + PRICE_SCALE);
  const m = factor(value, depth);
  const price = (open * (BPS - SLIP_BPS) * m.den) / (BPS * m.num);
  const gross = (qty * price * 10n ** 6n) / 10n ** BigInt(QTY_SCALE + PRICE_SCALE);
  const proceeds = (gross * (BPS - FEE_BPS)) / BPS;
  return { proceeds, fee: gross - proceeds, price, gross };
}

export interface Decision { action: 'buy' | 'sell' | 'none'; notional?: bigint; qty?: bigint; maxSlipBps: number }

export interface SimOptions {
  /** Called once per bar with the index and the bar; returns the order decided on it. */
  decide: (i: number, bars: SimBar[], hold: bigint, cash: bigint) => Decision;
}

export interface SimResult { pnl: bigint; trades: number; maxDrawdown: number; finalCash: bigint }

export function simulate(bars: SimBar[], opts: SimOptions): SimResult {
  let cash = START;
  let qty = 0n;
  let trades = 0;
  let peak = START;
  let maxDd = 0;
  let pending: { side: 'buy' | 'sell'; amount: bigint; close: bigint; maxSlip: bigint } | null = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // resolve the previous bar's decision at this bar's open
    if (pending !== null) {
      if (pending.side === 'buy') {
        const f = buyFill(pending.amount, bar.o, bar.od[0]);
        const ok = f.price * BPS <= pending.close * (BPS + pending.maxSlip);
        if (ok && f.qty > 0n && pending.amount <= cash) {
          cash -= pending.amount; qty += f.qty; trades++;
        }
      } else {
        const f = sellFill(pending.amount, bar.o, bar.od[0]);
        const ok = f.price * BPS >= pending.close * (BPS - pending.maxSlip);
        if (ok && pending.amount <= qty) {
          cash += f.proceeds; qty -= pending.amount; trades++;
        }
      }
      pending = null;
    }
    const equity = cash + (qty * bar.c * 10n ** 6n) / 10n ** BigInt(QTY_SCALE + PRICE_SCALE);
    if (equity > peak) peak = equity;
    const dd = Number(peak - equity) / Number(START);
    if (dd > maxDd) maxDd = dd;
    if (i === bars.length - 1) break;
    const d = opts.decide(i, bars, qty, cash);
    if (d.action === 'buy' && d.notional !== undefined && d.notional > 0n) {
      pending = { side: 'buy', amount: d.notional, close: bar.c, maxSlip: BigInt(d.maxSlipBps) };
    } else if (d.action === 'sell' && d.qty !== undefined && d.qty > 0n) {
      pending = { side: 'sell', amount: d.qty, close: bar.c, maxSlip: BigInt(d.maxSlipBps) };
    }
  }
  // final flatten at the last close
  const last = bars[bars.length - 1];
  if (qty > 0n) {
    const f = sellFill(qty, last.c, last.cd[0]);
    cash += f.proceeds;
  }
  const pnl = cash - START;
  return { pnl, trades, maxDrawdown: maxDd, finalCash: cash };
}
