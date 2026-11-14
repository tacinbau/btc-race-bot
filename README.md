# BTC Race bot — sharp-drop V-reversal (cbBTC/USDC, 1-minute bars)

Entry for **btc-race-24h-20261113-2314** ("Race a BTC trading bot live for
24 hours"): a long-only bot trading cbBTC against USDC on 1-minute on-chain
bars, starting with $1,000 of paper money. It speaks
`agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) and runs
as `node /bot/main.ts` (Node 22, standard library only).

## Strategy

The published 24h dev window is a choppy downtrend (-4.9% start to end) in
which the kit baselines all lose money after the ~26 bps round-trip cost
(4 bps fee + 2 bps slippage + ~7–10 bps price impact each way): buy-and-hold
≈ -$49, EMA-cross ≈ -$109, RSI-Bollinger ≈ -$66, momentum ≈ -$83
(verified with the kit's local grader). The only repeatable edge found in
the window is the **V-reversal**: a sharp 15-minute washout followed by a
bounce off the 15-minute low. The bot sits in cash and waits for that shape.

**Entry** (on a bar's close, filled at the next bar's open), when flat:

- some 15-minute return over the last 15 bars is below **-0.9%**, and
- the close has bounced at least **+0.3%** off the 15-minute low, and
- the close is above the previous close (an uptick).

It buys with the whole cash balance (one position, up to 100% of equity).

**Exit** (the whole position), when any holds at a close:

- take-profit: position value ≥ **101.5%** of cost, or
- stop-loss: position value ≤ **99.2%** of cost, or
- trailing stop: close ≤ **99.6%** of the highest close since entry, or
- max hold: **240 bars** since the entry decision.

Every order caps slippage at **100 bps** (1%) past the deciding close, so a
fill into a gap is refused rather than chased.

All decisions are exact integer arithmetic on the bars (no floats, no wall
clock, no environment, no randomness), so two runs on the same data produce
the same orders.

## Local verification (dev window)

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Result on the frozen 24h dev window (1,440 bars), from the kit's own
grader (`grade-local --driver process`, result
`66f895dbe1803af72d5c8adfca98843f8696479890d3bae3cfb284b2397ac1a0`):

| metric | value |
| --- | --- |
| Net PnL | **+$7.034766** |
| Fills | 4 (2 round trips) |
| Max drawdown | 0.9287% |
| Fees | $1.598261 |
| Determinism | L1 reproduced (two runs, identical action logs) |
| Baseline comparison | RSI-Bollinger -$65.83, EMA-cross ≈ -$109, buy-and-hold ≈ -$49 |

The parameters sit on a plateau, not a knife edge: drop thresholds
0.85%–1.00% and bounce thresholds 0.2%–0.4% all give the same two round
trips and a positive dev PnL (checked with an offline replay of the same
fill model, which reproduces the kit grader's RSI-Bollinger score exactly:
-$65.83, 11 trades).

Determinism: `grade-local` runs the bot twice and requires byte-identical
action logs; the bot's decisions depend only on the bars it is sent.

## Files

- `main.ts` — the bot (entrypoint).
- `README.md` — this file.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
