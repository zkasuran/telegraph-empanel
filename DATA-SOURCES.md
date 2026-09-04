# Data sources

Every input Empanel uses, with the sentence that grants us the right to use it.
A source whose grant cannot be quoted does not ship.

## Telegraph Protocol (the only source of answers)

- **Paid inference**, `POST /engine/v1/ask` and `POST /engine/v1/ask/{minerId}` on
  `https://devnode.telegraphprotocol.com`. Each call is paid per request with x402 in
  USDC on Base Sepolia, from our own wallet. The grant is the payment itself: the
  protocol's own documentation states the terms of trade, "Pay per call for AI
  inference using the x402 HTTP payment standard, no API key, no account, just USDC",
  and "Payment settles only when the miner actually answers."
- **Free discovery reads**, `GET /api/miners`, `GET /engine/v1/intents`,
  `GET /engine/v1/signal/{hash}`, `GET /daemon/api/questions` and
  `GET /daemon/api/categories`. The documentation lists these under "Endpoints That
  Don't Require Payment (Discovery)" and states "Inference is paid. Discovery and
  health endpoints are always open." The Daemon feed additionally states "the Daemon
  allows GET from any origin (`Access-Control-Allow-Origin: *`), so a frontend can
  read it directly. This is exactly how the Intelligence Terminal renders its feed."
- **Answer content.** A miner's answer is served to us because we paid for it. Empanel
  republishes each answer on the case page beside the miner that gave it, its
  `signal_hash` and its settlement transaction, so attribution travels with the text.
  The protocol records the same association publicly at
  `GET /engine/v1/signal/{hash}`.

Empanel adds no upstream data of its own. It does not scrape, and it holds no API key
for any third-party service. Everything on a case page came from a miner that was paid
for it, or from the chain.

## Base Sepolia

- **RPC** `https://sepolia.base.org`, the public endpoint Base publishes for its own
  testnet, used for reads and for sending our own transactions.
- **Explorer links** point at `base-sepolia.blockscout.com`. We link to it, we do not
  ingest it.
- Testnet ETH and testnet USDC hold no monetary value. Testnet USDC is obtained from
  Circle's own faucet, which states "This Faucet is public and permissionless for
  anyone to use. There's no account required" and "Developers can request 20 USDC on
  testnet every 2 hours, per address, and per blockchain."

## The coverage table

`data/coverage.json` grades 995 answers that already existed in the protocol's public
signal feed. None of those calls were ours and none were paid for by us: they are other
people's traffic, read from an endpoint the protocol documents as open, and graded by
reading each miner's own declared `label_field`. The table reports what the network did,
not our opinion of any operator. `data/build-data.mjs` regenerates it.

## Fonts

Roboto Mono, served by Google Fonts, licensed under the Apache License 2.0, which
permits use and redistribution with attribution. No font file is bundled.

## Third-party code

See [NOTICE](NOTICE). The two upstream libraries are Apache-2.0 (`@x402/*`) and MIT
(`viem`), both of which permit use in a source-available product provided their notices
travel with it, which NOTICE does.
