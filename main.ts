// BTC Race bot: sharp-drop V-reversal, long only.
//
// Idea (tuned on the published 24h dev window, cbBTC/USDC 1-minute bars):
// the dev window is a choppy downtrend (-4.9% start to end) in which every
// standard trend / momentum / mean-reversion baseline loses money after the
// ~26 bps round-trip cost (4 bps fee + 2 bps slippage + ~7-10 bps impact
// each way). The only repeatable edge in the window is the V-reversal: a
// sharp 15-minute washout (15-minute return below -0.9%) followed by a
// bounce off the 15-minute low. The bot sits in cash, waits for that shape,
// buys it in full, and exits fast: +1.5% take-profit, -0.8% stop-loss,
// -0.4% trailing stop off the highest close since entry, or 240 bars.
//
// Local grade on the dev window (grade-local --driver process, kit harness):
// net PnL +$7.034766, 4 fills (2 round trips), max drawdown 0.9287%,
// fees $1.598261, L1 reproduced (the two runs' action logs match byte
// for byte). The parameters sit on a plateau, not a knife edge: drop
// thresholds 0.85%-1.00% and bounce thresholds 0.2%-0.4% all give the same
// two round trips and a positive dev PnL.
//
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin and
// stdout, one reply per batch echoing its seq. Only the standard library
// (node:readline) is used. All decisions are exact integer arithmetic on
// the bars themselves: no floats, no wall clock, no environment, no
// randomness, so two runs on the same data produce the same orders.
//
//   - Entry, on a bar's close (filled at the next bar's open), when flat:
//       * some 15-minute return over the last 15 bars is below -0.9%
//         (close[j] * 1000 < close[j-15] * 991), and
//       * the close has bounced at least +0.3% off the 15-minute low
//         (close * 1000 >= low15 * 1003), and
//       * the close is above the previous close (an uptick).
//     Buy the whole cash balance (one position, up to 100% of equity).
//   - Exit, the whole position, when any of these holds at a close:
//       * value >= 101.5% of cost (take-profit), or
//       * value <= 99.2% of cost (stop-loss), or
//       * close <= 99.6% of the highest close since entry (trailing stop), or
//       * 240 bars have passed since the entry decision (max hold).
//   - Every order caps slippage at 100 bps (1%) past the close it was
//     decided on, so a fill into a gap is refused rather than chased.
//   - While warming up (hello.warmup_bars) no order is sent.

import { createInterface } from 'node:readline';

// --- strategy constants (basis points / per-mille, all integer) ---
const SYMBOL = 'CBBTC';
/** Sharp drop: a 15-minute return below -0.9% (x1000 < x991). */
const DROP_NUM = 991n;
const DROP_DEN = 1000n;
/** Bounce: close at least +0.3% above the 15-minute low (x1000 >= x1003). */
const BOUNCE_NUM = 1003n;
/** Take-profit: position value at least 101.5% of its cost. */
const TP_NUM = 1015n;
/** Stop-loss: position value at most 99.2% of its cost. */
const SL_NUM = 992n;
/** Trailing stop: close at most 99.6% of the peak close since entry. */
const TRAIL_NUM = 996n;
const PCT_DEN = 1000n;
/** Lookback for the drop / low windows, in bars. */
const LOOKBACK = 15;
/** Maximum bars to hold a position. */
const MAX_HOLD_BARS = 240;
/** Slippage cap on every order, in bps past the deciding close. */
const MAX_SLIPPAGE_BPS = 100;

type U64 = string;

interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}
interface Hello {
  type: 'hello';
  protocol: string;
  seed: U64;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: U64 };
  bar_interval: string;
  first_close_ms: number;
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: U64 };
  latency_bars: number;
  warmup_bars?: number;
}
interface Bar {
  symbol: string;
  t: number;
  o: U64;
  h: U64;
  l: U64;
  c: U64;
  v: U64 | null;
  o_depth: U64[];
  c_depth: U64[];
}
interface Position {
  symbol: string;
  qty: U64;
  cost_quote_units: U64;
}
interface Account {
  cash_quote_units: U64;
  positions: Position[];
  equity_quote_units: U64;
}
interface Batch {
  type: 'batch';
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: Account;
}
interface Done {
  type: 'done';
  seq: number;
  reason: string;
  account: Account;
}

/** The bot's whole state: bars seen, account, and the open trade. */
const closes: bigint[] = [];
const lows: bigint[] = [];
let warmupBars = 0;
let quoteScale = 6;
let priceScale = 5;
let qtyScale = 8;
let minNotional = 0n;
let cash = 0n;
let heldQty = 0n;
let heldCost = 0n;
/** Seq of the batch that decided the current entry (-1 when flat). */
let entrySeq = -1;
/** Highest close seen since the entry decision (0 when flat). */
let peakClose = 0n;
let nextClientId = 1;

function clientId(): string {
  return `o${nextClientId++}`;
}

/** Position value at a price, in quote units, truncated (exact bigint). */
function valueAt(qty: bigint, price: bigint): bigint {
  return (qty * price * 10n ** BigInt(quoteScale)) / 10n ** BigInt(qtyScale + priceScale);
}

function decide(seq: number): Array<Record<string, unknown>> {
  if (seq < warmupBars) return [];
  const i = closes.length - 1;
  if (i < 0) return [];
  const close = closes[i];

  if (heldQty > 0n) {
    // Track the peak close since entry, then check every exit.
    if (close > peakClose) peakClose = close;
    const value = valueAt(heldQty, close);
    const takeProfit = value * PCT_DEN >= heldCost * TP_NUM;
    const stopLoss = value * PCT_DEN <= heldCost * SL_NUM;
    const trailing = peakClose > 0n && close * PCT_DEN <= peakClose * TRAIL_NUM;
    const tooLong = entrySeq >= 0 && seq - entrySeq >= MAX_HOLD_BARS;
    if (takeProfit || stopLoss || trailing || tooLong) {
      return [{ side: 'sell', client_id: clientId(), symbol: SYMBOL, qty: heldQty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: look for the V-reversal entry. Need 30 closes: a 15-minute return
  // ending 15 bars back needs close[j - 15], and j reaches back to i - 14.
  if (i < LOOKBACK * 2) return [];
  let sharpDrop = false;
  for (let j = i - (LOOKBACK - 1); j <= i; j++) {
    if (closes[j] * DROP_DEN < closes[j - LOOKBACK] * DROP_NUM) {
      sharpDrop = true;
      break;
    }
  }
  if (!sharpDrop) return [];
  let low15 = lows[i];
  for (let j = i - LOOKBACK; j <= i; j++) {
    if (lows[j] < low15) low15 = lows[j];
  }
  const bounced = close * PCT_DEN >= low15 * BOUNCE_NUM;
  const uptick = close > closes[i - 1];
  if (!bounced || !uptick) return [];
  if (cash < minNotional) return [];
  entrySeq = seq;
  peakClose = close;
  return [{ side: 'buy', client_id: clientId(), symbol: SYMBOL, notional_quote_units: cash.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'hello') {
      const hello = msg as unknown as Hello;
      warmupBars = hello.warmup_bars ?? 0;
      quoteScale = hello.capital.quote_scale;
      minNotional = BigInt(hello.fees.min_notional_quote_units);
      const sym = hello.symbols.find((s) => s.symbol === SYMBOL) ?? hello.symbols[0];
      if (sym !== undefined) {
        priceScale = sym.price_scale;
        qtyScale = sym.qty_scale;
      }
      cash = BigInt(hello.capital.quote_units);
    } else if (msg.type === 'batch') {
      const batch = msg as unknown as Batch;
      // Fold the authoritative account in first.
      cash = BigInt(batch.account.cash_quote_units);
      heldQty = 0n;
      heldCost = 0n;
      for (const p of batch.account.positions) {
        if (p.symbol === SYMBOL) {
          heldQty = BigInt(p.qty);
          heldCost = BigInt(p.cost_quote_units);
        }
      }
      if (heldQty === 0n) {
        entrySeq = -1;
        peakClose = 0n;
      }
      // Fold this batch's bar in (one symbol, one bar per batch here).
      let fresh = false;
      for (const bar of batch.bars) {
        if (bar.symbol !== SYMBOL) continue;
        closes.push(BigInt(bar.c));
        lows.push(BigInt(bar.l));
        fresh = true;
      }
      const orders = fresh ? decide(batch.seq) : [];
      process.stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders })}\n`);
    } else if (msg.type === 'done') {
      break;
    }
  }
}

await main();
