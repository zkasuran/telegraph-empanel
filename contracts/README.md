<!-- SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0 -->

# The on-chain half of Empanel

Two contracts on Base Sepolia. `MinerCourt` is where a jury of Telegraph miners
has its verdict written down, and it is also the ERC-8183 callback the protocol
delivers an appeal into. `Gate` is the smallest contract that shows why the
register is worth anything: it acts only while a panel still says the claim
holds, and it refuses out loud otherwise.

Addresses, every transaction and the ABI fragments the app uses are in
[`ADDRESSES.json`](ADDRESSES.json).

| | |
| --- | --- |
| MinerCourt | `0x86F03643Fb772ea1D55B91C5CFaea3B3184bf3A3` |
| Gate | `0x614b6Cd8caD480C384d612505C84B91e9F03A796` |
| Telegraph Diamond | `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8` |
| chain | Base Sepolia, 84532 |

## Why a register and not just a page

A contract cannot make an HTTP request and cannot check a keccak preimage it
never saw, so the only way a miner's answer reaches contract storage is the
protocol's own ERC-8183 job rail. That rail was idle when we started: `jobCount()`
read 33 all time and nobody on the network had created a job since
2026-09-03 07:26 UTC. Jobs 33 and 34 are ours.

`latestAnswer` is deliberately shaped like a price feed. Anyone who has read a
Chainlink aggregator can consume a verdict without learning anything about
Empanel first.

`panelRoot` is a Merkle root over the sorted signal hashes of the jurors who
voted, so one word commits the whole panel. `verifyJuror` proves a given miner's
signal was part of the panel behind a verdict, which means a verdict quoted three
days later is still checkable against chain state plus the protocol's own signal
records, with no trust in our server.

## Reproduce every claim

Reads first, no key needed:

```bash
RPC=https://sepolia.base.org
MC=0x86F03643Fb772ea1D55B91C5CFaea3B3184bf3A3
G=0x614b6Cd8caD480C384d612505C84B91e9F03A796

# the register is wired to the real Diamond
cast call $MC "diamond()(address)" --rpc-url $RPC

# two cases committed, two appeals answered
cast call $MC "caseCount()(uint256)"   --rpc-url $RPC   # 2
cast call $MC "appealCount()(uint256)" --rpc-url $RPC   # 2
cast call $MC "appealJobs()(uint256[])" --rpc-url $RPC  # [33, 34]

# the supported case, read the feed-shaped way
CLAIM=0x60548c6897ac877688c5b502c4184efff295203b5265fc0e5a10f8255ae16d2f
cast call $MC "latestAnswer(bytes32)(uint8,uint16,uint16,uint256)" $CLAIM --rpc-url $RPC
# 1 (supported), 6000 bp, panel of 3, timestamp

# the hung case, which the gate refuses
HUNG=0x734020a58013ea75289e80a48f7a9ccae5c13ea9a9ea2363c227a1681f4b33df
cast call $MC "latestAnswer(bytes32)(uint8,uint16,uint16,uint256)" $HUNG --rpc-url $RPC
# 3 (hung), 5000 bp

# the gate acted once, on the supported case only
cast call $G "actions()(uint256)" --rpc-url $RPC          # 1
cast call $G "minConfidenceBp()(uint16)" --rpc-url $RPC   # 5000
```

The two transactions that matter most are a pair. The gate fired on the supported
case and reverted on the hung one:

| | |
| --- | --- |
| acted | [`0x27cbde04…1932fbd4b2`](https://base-sepolia.blockscout.com/tx/0x27cbde04c046a6b9211b023c85a8c748a57e93e5debaca72a6e58a1932fbd4b2) |
| refused, `NotSupported(3)` | [`0x0452cf69…0c987f9ca2d`](https://base-sepolia.blockscout.com/tx/0x0452cf690e9d1298261a416d6c8f502f3c0ab43c1bbc9f610720c0c987f9ca2d) |

## The appeal, end to end

An appeal is a real ERC-8183 job. It costs 1.00 USDC from our on-chain escrow,
takes one to six minutes, pays the answering miner 0.98 USDC converted to MACHINA
and 0.02 to the treasury, then the Diamond calls `subnetMessage` on MinerCourt.
Both appeals used intents where we operate no miner, so the money always leaves
our control.

Read what the protocol delivered on chain:

```bash
# the answer for job 34, decoded out of the AppealAnswered event
cast logs --from-block 46378211 --to-block 46378211 --address $MC --rpc-url $RPC
```

Job 34, intent `CHAT_COMPLETION`, delivered integers `[9500]` and this string:

> Supported. No credible source lists Morpho on Base as a scam or phishing
> target. Its official documentation, Base's security advisories, and community
> forums contain no warnings or reports of fraudulent activity linked to Morpho.

Job 33, intent `FACT_CHECK`, delivered a refusal, and we publish refusals rather
than hiding them:

> error:invalid_domain, verdict:unknown, reason: No hostname was supplied with
> this request, so the TLS/SSL certificate could not be analyzed.

## Build and test

```bash
forge build   # solc 0.8.28, optimizer on, no external imports
forge test    # 16 tests
```

The suite covers the recorder and Diamond access rules, the verdict validation,
the freshness window, Merkle membership for a juror and for an outsider, the
appeal round trip, and all four ways the gate refuses.

`panel-root.mjs` builds a panel root the same way the contract verifies it, with
leaves sorted ascending and each level hashing the pair in ascending order, so
the app and the contract cannot disagree about a proof.

## Notes worth keeping

- `subnetMessage` does one storage write and one event. Telegraph calls a callback
  with only the gas left in the settling transaction and swallows a revert, so a
  heavy callback loses the record while the job still settles and still pays.
- `createJob` does not validate the intent id and only checks that the callback
  address has code. A wrong id burns 1.00 USDC on a job that can never route, so
  check the id against `getCanonicalIntents()` first.
- Escrow is one way. There is no `withdrawUSDC` and no `requestWithdrawal` on this
  Diamond, so anything deposited beyond what Telegraph consumes is stranded.
  Deposit deliberately.
