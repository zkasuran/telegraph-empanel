# Empanel

**A jury of independent Telegraph miners, and the receipts.**

Live: **https://empanel.margyn.workers.dev**

Telegraph's router answers a question with one miner. Empanel takes that answer,
then puts the same question to the rest of the bench, counts only the votes whose
signal hash it can re-derive itself, and publishes what the jury agreed on and
where it split. When a jury holds, the verdict is written to a contract on Base
Sepolia where any other contract can read it and act on it. We pay for every call,
so a visitor needs no wallet and no account.

Built for Telegraph Hackathon Season I, Track 3.

**State at submission**, all of it checkable from the links below: 219 paid Telegraph
calls across 25 distinct miners and 8 intents, 21 cases tried, 15 corroborated and 6
hung, 22 verdicts written to `MinerCourt` on Base Sepolia, 2 ERC-8183 appeals answered
on chain by the protocol, and every counted vote's `signal_hash` re-derived locally.
Live counters are on [`/ledger`](https://empanel.margyn.workers.dev/ledger), which also
splits author-seeded cases from visitor cases rather than folding them together.

---

## Why

One call to one miner cannot tell you when that miner is wrong. We graded 995 real
answers taken off the network's own public feed, reading each miner's verdict out of
the field that miner declares and the protocol's validators grade. The network splits
cleanly in two:

| answers nearly always | never returns a readable verdict |
| --- | --- |
| ONCHAIN_TX_LOOKUP 34/34, GAS_PRICE 22/22, WALLET_BALANCE_CHECK 14/14, SSL_VERIFICATION 12/12, IP_GEOLOCATION 7/7, STORM_ALERT 258/269, TOKEN_HOLDER_COUNT 84/111 | NEWS_SEARCH 0/30, FACT_CHECK 0/18, WEB_SEARCH 0/13, CHAT_COMPLETION 0/14, CONTENT_MODERATION 0/13, CRYPTO_PRICE 22/122 |

So Empanel does two things a single call cannot. It corroborates where
corroboration is possible, and it **refuses, in public, with the numbers**, where it
is not. Charging a visitor to watch eleven miners abstain is not a product. The whole
table is at [`/coverage`](https://empanel.margyn.workers.dev/coverage).

## How a case runs

1. **Juror zero is the protocol's own router.** `POST /engine/v1/ask` classifies the
   claim and answers it. That answer is shown first and labelled as exactly what a
   one-call app would have given you. Its intent decides the bench.
2. **The rest of the jury is drawn by lot.** Every miner that is active, priced at the
   floor, declares a `label_field`, has an addressable endpoint for the intent and is
   **not operated by us** goes into the pool. The draw is seeded with
   `keccak256(claimHash || openedAt)`, so it is a pure function of the case id and
   anyone can recompute the panel from the case page.
3. **Each juror is asked directly**, `POST /engine/v1/ask/{minerId}`, with a payload
   built from that miner's own declared parameters. What we sent is on the page.
4. **Every vote is verified before it counts.** We re-derive the answer's
   `signal_hash` ourselves. A vote we cannot reproduce is shown and not counted.
5. **The tally.** Votes are clustered on the comparable core of the answer, numbers
   with a tolerance, verdicts as verdicts, prose by token overlap. Dissent is named.
   Under 60% agreement the jury is hung and we say so.
6. **The panel grows only on conflict**, 3 then 7 then 11. Silence never grows a jury,
   because paying more miners to abstain is not evidence.
7. **The verdict goes on chain.** `MinerCourt.enterVerdict` records the outcome, the
   confidence and a Merkle root over the jurors' signal hashes.
8. **A person can appeal.** If three visitors disagree with the machines and more
   disagree than agree, Empanel spends 1.00 USDC of on-chain escrow to open a real
   ERC-8183 job, so a miner answers again through the on-chain rail and that answer
   lands in the contract as the record.

## The three things nobody else on this network is doing

**We re-derive the signal hash.** Telegraph publishes a hash beside every answer and
says the algorithm is keccak256 over the payload, but not what the preimage is. It is
Go's own JSON encoding: keys sorted at every level, the wallet lowercased, `<` `>` `&`
escaped, everything else raw UTF-8. The payload as served arrives in Go struct order,
so hashing the bytes you receive fails. We reproduce it 31 of 31 on live fixtures, and
[`/verify`](https://empanel.margyn.workers.dev/verify) will do it for **anyone's**
signal, not only ours. See [`src/signalhash.js`](src/signalhash.js) and
[`tools/fixtures`](tools/fixtures).

**We use the on-chain job rail.** It was idle: `jobCount()` read 33 all time and no
job had been created protocol-wide since 2026-09-03 07:26 UTC. Our appeals are jobs
33 and 34, both answered by the protocol into our callback. Everything is reproducible
from [`contracts/README.md`](contracts/README.md).

**Our own miners are barred from every jury.** We operate 25 miners on this network
and wrote the active scoring module on all 45 intents, which is a conflict, so we
removed it structurally rather than in a paragraph. The bar is by wallet address, in
[`src/panel.js`](src/panel.js), and it is applied before the draw. When the protocol's
router picks one of ours for juror zero we show the answer and refuse to count it, so
no corroboration figure rests on our own supply.

## Usage, counted the way you can check

The protocol has no app id and no API key, so the only honest measure of "calls made
by this application" is the payer wallet: `0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287`.

- **On chain.** Every paid call is one USDC transfer from that wallet to the Telegraph
  Diamond `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8`. Count them on
  [Blockscout](https://base-sepolia.blockscout.com/address/0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287?tab=token_transfers).
- **Off chain.** Walk `GET /daemon/api/questions`, fetch `/engine/v1/signal/{hash}` for
  each row and keep the rows whose `payload.wallet_address` is ours.
- **Ours.** [`/ledger`](https://empanel.margyn.workers.dev/ledger) lists every paid call
  with what triggered it, and [`/api/evidence`](https://empanel.margyn.workers.dev/api/evidence)
  reconciles the two counts. A signal record does not always carry its settlement tx,
  so the feed undercounts and the on-chain figure is the ground truth. We publish both
  rather than the flattering one.

Caps are printed on every page: 8 cases per hour per address and $8 of sponsored calls
a day. The app refuses out loud when one is hit.

## Run it

```bash
npm install
npx wrangler kv namespace create EMPANEL       # put the id in wrangler.toml
npx wrangler secret put PAYER_KEY              # a key holding Base Sepolia USDC
npx wrangler secret put VOTE_SALT              # any random string
npx wrangler deploy
```

The payer needs USDC and **no ETH**: x402 settles through EIP-3009, so a facilitator
broadcasts the transfer and the payer never pays gas. Testnet USDC comes from
[faucet.circle.com](https://faucet.circle.com), 20 per claim on Base Sepolia.

Contracts:

```bash
cd contracts && forge build && forge test    # 16 tests
```

## Two things we learned the hard way

**Concurrent payments from one payer are rejected with a bare 402.** Five parallel
calls lost two, and a bare 402 is indistinguishable from not paying, so the failure is
silent. A 450ms stagger fixes it. Empanel serialises every paid call through one
queue with a retry, in [`src/x402.js`](src/x402.js). Failed calls cost nothing.

**The payment header is not just a signature.** It must echo the requirement you chose
(`accepted`) and the resource you are paying for (`resource`). Leave either out and you
get the same bare 402.

## Layout

| | |
| --- | --- |
| `src/x402.js` | the payer: EIP-3009 signing, the stagger queue, retries |
| `src/signalhash.js` | independent re-derivation of a signal hash |
| `src/panel.js` | eligibility, the wallet bar, the draw by lot |
| `src/verdict.js` | reading a vote out of its declared field, clustering, the tally |
| `src/case.js` | running a case, escalation, the panel root |
| `src/recorder.js` | writing verdicts and opening appeals on Base Sepolia |
| `contracts/` | MinerCourt and Gate, with every proving transaction |
| `data/` | the adapter map, the intent set and the coverage table, all regenerable |
| `tools/` | the verifier, the usage reconciler, the concurrency probe |

## Licence

Source-available, no derivatives. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Third-party terms are quoted in [DATA-SOURCES.md](DATA-SOURCES.md).

AI assistance (Claude, Anthropic) was used in developing this project. The design,
review and verification are the author's. Every number in this README was measured
against the live network or the live chain, and every transaction hash is real.
