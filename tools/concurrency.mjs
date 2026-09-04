// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Why did two of five concurrent paid calls come back as a bare 402?
// Tests, in order: the same two miners one at a time, then a small stagger, so
// the panel knows whether it can fan out or has to pace itself.
//
// Run: node tools/concurrency.mjs

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";

const NODE = "https://devnode.telegraphprotocol.com";
const env = fs.readFileSync("/home/asuran/Downloads/hackathon-hq/work/telegraph/.wallet.env", "utf8");
const account = privateKeyToAccount((env.match(/0x[0-9a-fA-F]{64}/) || [])[0]);
const client = x402Client.fromConfig({
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(toClientEvmSigner(account)) }],
});
const payFetch = wrapFetchWithPayment(fetch, client);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(m) {
  const t0 = Date.now();
  try {
    const res = await payFetch(`${NODE}/engine/v1/ask/${m.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "curl/8.5.0" },
      body: JSON.stringify({ method: m.method, endpoint: m.endpoint, payload: m.payload }),
    });
    const ms = Date.now() - t0;
    const body = await res.text();
    return { slug: m.slug, status: res.status, ms, hint: res.ok ? "ok" : body.slice(0, 90) };
  } catch (e) {
    return { slug: m.slug, status: "throw", ms: Date.now() - t0, hint: String(e).slice(0, 90) };
  }
}

const A = { id: "8453", slug: "truvian", method: "GET", endpoint: "/gas", payload: { chain: "base" } };
const B = { id: "302", slug: "chainsight", method: "GET", endpoint: "/gas", payload: { chain: "base" } };
const C = { id: "9002", slug: "txlens", method: "GET", endpoint: "/gas-price", payload: { chain: "base" } };

console.log("TEST 1: serial, the two that failed under load");
for (const m of [A, B]) console.log("  ", await ask(m));

console.log("\nTEST 2: three at once, no stagger");
console.log((await Promise.all([A, B, C].map(ask))).map((r) => `   ${r.slug} ${r.status} ${r.ms}ms ${r.hint}`).join("\n"));

console.log("\nTEST 3: three, staggered 400ms");
const staggered = [];
for (const [i, m] of [A, B, C].entries()) {
  staggered.push((async () => {
    await sleep(i * 400);
    return ask(m);
  })());
}
console.log((await Promise.all(staggered)).map((r) => `   ${r.slug} ${r.status} ${r.ms}ms ${r.hint}`).join("\n"));
