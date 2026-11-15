# btc-flush

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/1Serv0x/btc-flush/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/1Serv0x/btc-flush/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A long-only cbBTC/USDC bot that holds cash and buys a liquidity flush: when the pool falls 250 bps over 90 minutes it takes the position and holds it for two hours, with a 150 bps stop and an equity circuit breaker.

The pool's quote only moves when a taker crosses it, and a full round trip costs about 26 bps in fee, slippage and price impact. A small move cannot pay for that; a large one is a taker pushing the pool off the wider market's price, and that is the gap arbitrage closes. On the dev window the edge crosses zero right at that cost hurdle and stays positive above it.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/bars-replay/v1 protocol on stdin and stdout: the harness sends `hello`, then one batch per minute, and the bot answers each with at most one reply of orders. It is graded by running it twice and requiring both runs to write the same action log.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jg3dx8h5&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
