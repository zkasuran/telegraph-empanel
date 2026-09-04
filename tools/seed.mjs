#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Seed the docket with real cases so a first visitor lands on a live wall rather
// than an empty one. Every question here is one somebody would actually ask, each
// is asked once, and each is flagged as author-seeded so the site reports it
// separately from visitor traffic. Nothing is repeated to run a counter up.
//
//   node tools/seed.mjs <token> [n]

const BASE = process.env.EMPANEL_BASE || "https://empanel.margyn.workers.dev";
const token = process.argv[2];
const limit = Number(process.argv[3] || 100);
if (!token) {
  console.error("pass the seed token");
  process.exit(1);
}

// Chosen against the coverage table: intents where miners demonstrably answer, so
// a jury means something. One question per line, no duplicates.
const CLAIMS = [
  "What is the current gas price on Base?",
  "What is the gas price on Ethereum right now?",
  "What is the gas price on Arbitrum right now?",
  "Is the TLS certificate for github.com valid right now, and who issued it?",
  "Is the TLS certificate for cloudflare.com valid, and when does it expire?",
  "Is the TLS certificate for telegraphprotocol.com valid right now?",
  "Where is 8.8.8.8 located, and which network owns it?",
  "Where is 1.1.1.1 located, and which network operates it?",
  "Where is 9.9.9.9 located, and who runs that network?",
  "What is the storm risk in Manila over the next 24 hours?",
  "What is the storm risk in Mumbai over the next 24 hours?",
  "Is there a storm risk in Miami over the next 48 hours?",
  "What is the storm risk in Tokyo over the next 24 hours?",
  "How many holders does the token at 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 on base have?",
  "How many holders does the token at 0x4200000000000000000000000000000000000006 on base have?",
  "What is the USDC balance of 0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287 on base?",
  "What is the ETH balance of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 on ethereum?",
  "What is the ETH balance of 0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8 on base?",
  "What is the current share price of AAPL?",
  "What is the current share price of NVDA?",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
let fail = 0;

for (const [i, claim] of CLAIMS.slice(0, limit).entries()) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/case?seed=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "empanel-seed/1" },
      body: new URLSearchParams({ claim }),
      redirect: "manual",
    });
    const loc = res.headers.get("location") || "";
    const id = loc.split("/c/")[1] || "?";
    const doc = await fetch(`${BASE}/api/case/${id}`).then((r) => r.json());
    const t = doc.tally || {};
    console.log(
      `${String(i + 1).padStart(2)} ${((Date.now() - t0) / 1000).toFixed(1)}s ${String(doc.intent || "-").padEnd(22)} ` +
        `${String(t.outcome || doc.status).padEnd(14)} ${String(t.counted ?? 0)}/${(doc.jurors || []).length} counted  ${id}  ${claim.slice(0, 46)}`
    );
    ok += 1;
  } catch (e) {
    console.log(`${String(i + 1).padStart(2)} FAILED ${String(e).slice(0, 90)}  ${claim.slice(0, 40)}`);
    fail += 1;
  }
  await sleep(1500);
}
console.log(`\n${ok} seeded, ${fail} failed`);
const led = await fetch(`${BASE}/api/ledger`).then((r) => r.json());
console.log(`ledger now: ${led.calls} paid calls, $${led.usdc.toFixed(2)}`);
