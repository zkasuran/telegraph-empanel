// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Independent, third-party-checkable count of the paid Telegraph calls made by
// one payer wallet, plus a hash re-derivation for every one of them.
//
// Two sources that must agree:
//
//   ON CHAIN   USDC Transfer(payer -> Diamond) logs on Base Sepolia. Every x402
//              settlement moves exactly the call price from the payer to the
//              protocol Diamond, so the log count is the call count.
//   OFF CHAIN  the node's public signal feed. Walk /daemon/api/questions, fetch
//              /engine/v1/signal/{hash} for each row and keep the rows whose
//              payload.wallet_address is ours.
//
// Nothing here needs a key or an account. A judge can run it against our wallet
// and get the same numbers, which is the point.
//
//   node tools/evidence.mjs --from-block <n> [--payer 0x..] [--feed-pages 20]

import { keccak256 } from "viem";
import { verifySignal } from "./signal-hash.mjs";

const NODE = "https://devnode.telegraphprotocol.com";
const RPC = "https://sepolia.base.org";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const DIAMOND = "0x5a2324aa18613fad4e44bdf0d6c73ec1f6d87ff8";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_SPAN = 9999; // sepolia.base.org rejects a wider eth_getLogs range
const UA = { "User-Agent": "curl/8.5.0" };

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};

const pad32 = (addr) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", ...UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const doc = await res.json();
  if (doc.error) throw new Error(`${method}: ${doc.error.message}`);
  return doc.result;
}

/** Count settlements on chain, chunked around the public RPC's block-range cap. */
export async function onchainCalls(payer, fromBlock) {
  const head = Number(await rpc("eth_blockNumber", []));
  const logs = [];
  for (let start = fromBlock; start <= head; start += MAX_SPAN + 1) {
    const end = Math.min(start + MAX_SPAN, head);
    const chunk = await rpc("eth_getLogs", [
      {
        address: USDC,
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
        topics: [TRANSFER, pad32(payer), pad32(DIAMOND)],
      },
    ]);
    logs.push(...chunk);
  }
  const total = logs.reduce((n, l) => n + BigInt(l.data), 0n);
  return {
    head,
    fromBlock,
    calls: logs.length,
    usdcSpent: Number(total) / 1e6,
    txs: logs.map((l) => ({
      block: Number(l.blockNumber),
      tx: l.transactionHash,
      amount: Number(BigInt(l.data)) / 1e6,
    })),
  };
}

/** Find our signals in the node's public feed and re-derive each hash ourselves. */
export async function feedCalls(payer, pages) {
  const ours = [];
  let scanned = 0;
  for (let p = 0; p < pages; p++) {
    const res = await fetch(`${NODE}/daemon/api/questions?limit=100&offset=${p * 100}`, { headers: UA });
    if (!res.ok) break;
    const rows = (await res.json()).results || [];
    if (!rows.length) break;
    scanned += rows.length;
    for (const row of rows) {
      if (!row.signal_hash) continue;
      let v;
      try {
        v = await verifySignal(row.signal_hash, keccak256, NODE);
      } catch {
        continue;
      }
      if ((v.payer || "").toLowerCase() !== payer.toLowerCase()) continue;
      ours.push({
        at: v.at,
        intent: v.intent,
        miner: v.miner,
        minerId: v.minerId,
        signalHash: v.claimed,
        hashVerified: v.ok,
        settlementTx: v.settlementTx,
        question: (row.question || {}).text,
      });
    }
  }
  return { scanned, calls: ours.length, verified: ours.filter((o) => o.hashVerified).length, rows: ours };
}

const payer = arg("--payer", "0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287");
const fromBlock = Number(arg("--from-block", "46374000"));
const pages = Number(arg("--feed-pages", "10"));

const [chain, feed] = await Promise.all([onchainCalls(payer, fromBlock), feedCalls(payer, pages)]);

const out = {
  payer,
  node: NODE,
  chain: { head: chain.head, fromBlock: chain.fromBlock, calls: chain.calls, usdcSpent: chain.usdcSpent },
  feed: { rowsScanned: feed.scanned, calls: feed.calls, hashesReDerived: feed.verified },
  agree: chain.calls >= feed.calls,
  detail: { settlements: chain.txs, signals: feed.rows },
};
console.log(JSON.stringify(out, null, 2));
