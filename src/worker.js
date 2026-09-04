// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Empanel. One Worker is both the site and the payer, because the node sends no
// CORS preflight on /engine/v1/ask, so a browser cannot pay for its own call.

import routes from "../data/routes.json";
import coverageSlim from "../data/coverage-slim.json";
import chainAddr from "../contracts/ADDRESSES.json";
import { Store } from "./store.js";
import { tryCase } from "./case.js";
import { verifySignal } from "./signalhash.js";
import { loadCatalogue, eligibleJurors, OUR_WALLET } from "./panel.js";
import { commitVerdict, openAppeal, appealAllowed } from "./recorder.js";
import * as ui from "./ui.js";

const COURT = chainAddr.contracts.MinerCourt.address;
const DIAMOND = chainAddr.telegraph.diamond;

const DATA = {
  adapters: { adapters: routes.adapters.map((a) => ({ intent_id: a.i, miner_id: a.m, slug: a.s, method: a.me, endpoint: a.e, path_template: a.pt, payload: a.p, slots: (a.req || []).map((s) => ({ param: s, slot: s, required: true })), is_ours: false })) },
  coverage: { intents: Object.fromEntries(Object.entries(coverageSlim.intents).map(([k, v]) => [k, { observed_calls: v.c, observed_usable: v.u, usable_rate: v.r, router_description: v.d }])) },
};

const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });
const seeOther = (loc) => new Response(null, { status: 303, headers: { location: loc } });

async function counters(store) {
  const [c, budget] = await Promise.all([store.counters(), store.quotaState()]);
  return { ...c, budget };
}

function seatableRows(catalogueCounts) {
  const rows = [];
  for (const [intent, cov] of Object.entries(DATA.coverage.intents)) {
    const jurors = catalogueCounts[intent] || 0;
    rows.push({ intent, jurors, observed: cov.observed_calls || 0, usable: cov.observed_usable || 0, rate: cov.usable_rate });
  }
  rows.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.jurors - a.jurors);
  return rows;
}

function jurorCounts() {
  const n = {};
  for (const a of DATA.adapters.adapters) n[a.intent_id] = (n[a.intent_id] || 0) + 1;
  return n;
}

const clientIp = (req) => req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "0.0.0.0";

async function voterHash(env, ip, caseId) {
  const bytes = new TextEncoder().encode(`${env.VOTE_SALT || "empanel"}|${ip}|${caseId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const store = new Store(env.EMPANEL);

    try {
      if (path === "/health") return json({ ok: true, payerConfigured: Boolean(env.PAYER_KEY), adapters: DATA.adapters.adapters.length });

      if (path === "/") {
        const [c, docket] = await Promise.all([counters(store), store.docket(12)]);
        return html(ui.landing({ counters: c, docket, seatable: seatableRows(jurorCounts()) }));
      }

      if (path === "/docket") {
        const [c, docket] = await Promise.all([counters(store), store.docket(120)]);
        return html(ui.shell({ title: "Empanel docket", counters: ui.counterBar(c), body: `<h1>The docket</h1><p class="lede">Every case this app has tried, newest first.</p>${ui.docketTable(docket)}` }));
      }

      if (path === "/coverage") {
        const c = await counters(store);
        return html(ui.coveragePage({ counters: c, rows: seatableRows(jurorCounts()) }));
      }

      if (path === "/ledger") {
        const [c, led] = await Promise.all([counters(store), store.ledger()]);
        return html(ui.ledgerPage({ counters: c, led, payer: env.PAYER_ADDRESS }));
      }

      if (path === "/verify") {
        const c = await counters(store);
        const hash = url.searchParams.get("hash");
        let result = null;
        if (hash && /^(0x)?[0-9a-fA-F]{64}$/.test(hash.trim())) result = await verifySignal(hash.trim());
        else if (hash) result = { reason: "that is not a 32 byte hash" };
        return html(ui.verifyPage({ counters: c, hash, result }));
      }

      if (path === "/chain") {
        const [c, chain] = await Promise.all([counters(store), readChain(env)]);
        return html(ui.chainPage({ counters: c, chain }));
      }

      if (path.startsWith("/c/")) {
        const kase = await store.getCase(path.slice(3));
        if (!kase) return html(ui.shell({ title: "no such case", body: "<h1>No such case</h1><p><a href='/'>try a claim</a></p>" }), 404);
        const c = await counters(store);
        return html(ui.casePage({ kase, counters: c, host: url.host }));
      }

      // --- opening a case ---------------------------------------------------
      if (path === "/case") {
        let claim = url.searchParams.get("claim");
        if (request.method === "POST") {
          const form = await request.formData();
          claim = String(form.get("claim") || "");
        }
        claim = String(claim || "").trim().slice(0, 400);
        if (!claim) return seeOther("/");
        const seeded = url.searchParams.get("seed") === env.SEED_TOKEN && Boolean(env.SEED_TOKEN);
        const kase = await tryCase({ claim, env, store, data: DATA, ip: clientIp(request), seeded });
        // Committing the verdict is gas only, so every case that produced a jury
        // gets written to the register before the visitor sees the page.
        if (kase.status === "closed" && kase.tally?.counted && !kase.servedFromCache) {
          try {
            const res = await commitVerdict({ ...env, DIAMOND }, kase, COURT);
            if (res.verdictTx) {
              kase.onchain = res;
              await store.putCase(kase);
            }
          } catch (e) {
            kase.onchainError = String(e).slice(0, 200);
            await store.putCase(kase);
          }
        }
        return seeOther(`/c/${kase.id}`);
      }

      if (path === "/vote" && request.method === "POST") {
        const form = await request.formData();
        const id = String(form.get("id") || "");
        const agree = String(form.get("agree") || "") === "1";
        const vh = await voterHash(env, clientIp(request), id);
        const res = await store.recordVote(id, vh, agree);
        // Three people against the machines, and more against than for, opens a
        // real appeal. A person is always the trigger, never a timer.
        if (res.ok) {
          const k = res.case;
          const h = k.human || { agree: 0, disagree: 0 };
          if (!k.appeal && h.disagree >= 3 && h.disagree > h.agree && k.intent) {
            const cat = await loadCatalogue(env);
            if (appealAllowed(cat, k.intent, OUR_WALLET)) {
              try {
                const appeal = await openAppeal({ ...env, DIAMOND }, k, COURT, k.intent);
                k.appeal = appeal;
                await store.putCase(k);
              } catch (e) {
                k.appeal = { error: String(e).slice(0, 200) };
                await store.putCase(k);
              }
            } else {
              k.appeal = { skipped: `we operate a miner on ${k.intent}, so this intent is not appealable by us` };
              await store.putCase(k);
            }
          }
        }
        return seeOther(`/c/${id}${res.ok ? "" : "?voted=already"}`);
      }

      // --- machine readable -------------------------------------------------
      if (path === "/api/docket") return json(await store.docket(200));
      if (path === "/api/ledger") return json(await store.ledger());
      if (path === "/api/coverage") return json(seatableRows(jurorCounts()));
      if (path.startsWith("/api/case/")) {
        const kase = await store.getCase(path.slice("/api/case/".length));
        return kase ? json(kase) : json({ error: "no such case" }, 404);
      }
      if (path === "/api/verify") {
        const hash = url.searchParams.get("hash") || "";
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) return json({ error: "pass a 32 byte hash" }, 400);
        return json(await verifySignal(hash));
      }
      if (path === "/api/evidence") return json(await evidence(env, store));
      if (path === "/api/bench") {
        const intent = url.searchParams.get("intent") || "GAS_PRICE";
        const cat = await loadCatalogue(env);
        return json(eligibleJurors(cat, intent, null));
      }

      return html(ui.shell({ title: "not found", body: "<h1>Not found</h1><p><a href='/'>start over</a></p>" }), 404);
    } catch (err) {
      return json({ error: String(err && err.stack ? err.stack : err).slice(0, 800) }, 500);
    }
  },
};

// --- chain reads ------------------------------------------------------------

const RPC = "https://sepolia.base.org";

async function ethCall(to, data) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const doc = await res.json();
  return doc.result || "0x";
}
const SEL = {
  caseCount: "0xda2d7e95",
  appealCount: "0x7f52479a",
  actions: "0xf99e36bc",
  minConfidenceBp: "0x2b2a183a",
  jobCount: "0x4c5d8a0f",
  escrowBalance: "0x55af6353",
};
const uint = (hex) => (hex && hex !== "0x" ? Number(BigInt(hex)) : 0);

async function readChain(env) {
  const court = chainAddr.contracts.MinerCourt.address;
  const gate = chainAddr.contracts.Gate.address;
  const diamond = chainAddr.telegraph.diamond;
  const escrowData = SEL.escrowBalance + env.PAYER_ADDRESS.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const [caseCount, appealCount, actions, minC, jobCount, escrow] = await Promise.all([
    ethCall(court, SEL.caseCount),
    ethCall(court, SEL.appealCount),
    ethCall(gate, SEL.actions),
    ethCall(gate, SEL.minConfidenceBp),
    ethCall(diamond, SEL.jobCount),
    ethCall(diamond, escrowData),
  ]);
  return {
    court,
    gate,
    caseCount: uint(caseCount),
    appealCount: uint(appealCount),
    actions: uint(actions),
    minConfidenceBp: uint(minC) || 5000,
    jobCount: uint(jobCount),
    ours: chainAddr.provenTransactions.appeals.length,
    escrow: uint(escrow),
    actedTx: chainAddr.provenTransactions.gateActed.tx,
    refusedTx: chainAddr.provenTransactions.gateRefused.tx,
  };
}

/**
 * Our own usage, counted the two ways a stranger can check: the on-chain USDC
 * settlements from our payer to the Diamond, and the rows our ledger recorded.
 */
async function evidence(env, store) {
  const led = await store.ledger();
  const payer = env.PAYER_ADDRESS.toLowerCase();
  const diamond = chainAddr.telegraph.diamond.toLowerCase();
  const usdc = chainAddr.telegraph.usdc.toLowerCase();
  const pad = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
  const head = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  }).then((r) => r.json());
  const to = Number(BigInt(head.result));
  const from = to - 9990;
  const logs = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{ address: usdc, fromBlock: "0x" + from.toString(16), toBlock: "latest", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(payer), pad(diamond)] }],
    }),
  }).then((r) => r.json());
  const rows = logs.result || [];
  return {
    payer: env.PAYER_ADDRESS,
    howToCheckYourself: {
      onChain: `every USDC Transfer from ${env.PAYER_ADDRESS} to the Telegraph Diamond ${chainAddr.telegraph.diamond} is one paid call`,
      offChain: "walk https://devnode.telegraphprotocol.com/daemon/api/questions and fetch /engine/v1/signal/{hash} for each row, then keep the rows whose payload.wallet_address is ours",
      note: "the on-chain count is the ground truth. A signal record does not always carry its settlement tx, so the feed's tx_hash field undercounts.",
    },
    onChainWindow: { fromBlock: from, toBlock: to, settlements: rows.length, usdc: rows.reduce((s, l) => s + Number(BigInt(l.data)) / 1e6, 0) },
    appLedger: { paidCalls: led.calls, usdc: led.usdc },
    contracts: { court: chainAddr.contracts.MinerCourt.address, gate: chainAddr.contracts.Gate.address, appeals: chainAddr.provenTransactions.appeals },
  };
}
