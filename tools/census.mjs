// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Prototype of the panel call: ask the same question of N independent miners at
// once, read each one's verdict out of the field it declares itself, then
// re-derive every signal hash locally before counting the vote.
//
// Run: node tools/census.mjs

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import fs from "node:fs";
import { verifySignal } from "./signal-hash.mjs";

const NODE = "https://devnode.telegraphprotocol.com";
const env = fs.readFileSync("/home/asuran/Downloads/hackathon-hq/work/telegraph/.wallet.env", "utf8");
const account = privateKeyToAccount((env.match(/0x[0-9a-fA-F]{64}/) || [])[0]);
const client = x402Client.fromConfig({
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(toClientEvmSigner(account)) }],
});
const payFetch = wrapFetchWithPayment(fetch, client);

/** Resolve a dotted path, because four miners declare label_field as a.b.c */
const dig = (obj, path) =>
  String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);

async function directAsk(minerId, method, endpoint, payload) {
  const t0 = Date.now();
  const res = await payFetch(`${NODE}/engine/v1/ask/${minerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "curl/8.5.0" },
    body: JSON.stringify({ method, endpoint, payload }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { minerId, ok: false, status: res.status, ms, body: (await res.text()).slice(0, 200) };
  const doc = await res.json();
  return { minerId, ok: true, ms, doc };
}

const PANEL = [
  { id: "8453", slug: "truvian-onchain-truth", method: "GET", endpoint: "/gas", label: "signal" },
  { id: "147115", slug: "gaspulse-evm-fees", method: "GET", endpoint: "/gas", label: "level" },
  { id: "9002", slug: "txlens", method: "GET", endpoint: "/gas-price", label: "answer" },
  { id: "302", slug: "chainsight-oracle", method: "GET", endpoint: "/gas", label: "signal" },
  { id: "900", slug: "onchain-intel-miner", method: "GET", endpoint: "/gas-price", label: "signal" },
];
const PAYLOAD = { chain: "base", network: "base", query: "What is the current gas price on Base?" };

const t0 = Date.now();
const settled = await Promise.all(PANEL.map((m) => directAsk(m.id, m.method, m.endpoint, PAYLOAD)));
console.log(`wall clock for ${PANEL.length} concurrent paid calls: ${Date.now() - t0}ms\n`);

for (const [i, r] of settled.entries()) {
  const m = PANEL[i];
  if (!r.ok) {
    console.log(`${m.slug.padEnd(24)} FAILED http=${r.status} ${r.body}`);
    continue;
  }
  const verdict = dig(r.doc.result, m.label);
  let v = { ok: false };
  try {
    v = await verifySignal(r.doc.signal_hash, keccak256, NODE);
  } catch (e) {
    v = { ok: false, err: String(e).slice(0, 60) };
  }
  console.log(
    `${m.slug.padEnd(24)} ${String(r.ms).padStart(6)}ms  hash=${v.ok ? "VERIFIED" : "unverified"}  tx=${(v.settlementTx || "none").slice(0, 12)}\n` +
      `  ${m.label} = ${JSON.stringify(verdict).slice(0, 220)}`
  );
}
