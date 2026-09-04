// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Trying a case.
//
// Juror zero is always the protocol's own router, so the first answer on every
// case page is exactly what a one-call app would have shown, and its `intent`
// classification decides the bench. The rest of the jury is drawn by lot from the
// miners that are eligible for that intent, paid one at a time, and each vote is
// counted only if we can re-derive its signal hash ourselves.
//
// The app refuses to seat a jury it knows will abstain. Grading 995 real answers
// off the public feed showed whole intents where no miner has ever returned a
// readable verdict, and charging a visitor's sponsored budget to watch eleven
// miners say nothing is not a product. Those intents get a published refusal with
// the numbers behind it instead.

import { Payer, freeGet } from "./x402.js";
import { keccak256, concatHex } from "viem";
import { verifySignal } from "./signalhash.js";
import { loadCatalogue, eligibleJurors, drawLots, claimHashOf, PANEL_STEPS, OUR_WALLET } from "./panel.js";
import { readVote, comparable, tally, shouldEscalate } from "./verdict.js";
import { nowSec } from "./store.js";

/** Everything a juror needs, pulled out of the visitor's own words. */
export function parseSubject(claim) {
  const s = String(claim);
  const chainWords = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche", "solana", "sepolia"];
  const chainIds = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, bsc: 56, avalanche: 43114 };
  const chain = chainWords.find((c) => new RegExp(`\\b${c}\\b`, "i").test(s)) || "ethereum";
  const url = (s.match(/https?:\/\/[^\s"'<>]+/i) || [])[0] || null;
  const domain =
    (url ? new URL(url).hostname : null) ||
    (s.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i) || [])[1] ||
    (s.match(/\b([a-z0-9-]+\.(?:com|org|net|io|dev|xyz|app|co|ai|gov|edu))\b/i) || [])[1] ||
    null;
  const txHash = (s.match(/0x[0-9a-fA-F]{64}\b/) || [])[0] || null;
  const address = (s.match(/0x[0-9a-fA-F]{40}\b/) || [])[0] || null;
  const ip = (s.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [])[0] || null;
  const symbol = (s.match(/\$([A-Za-z]{2,6})\b/) || [])[1] || (s.match(/\b(BTC|ETH|SOL|USDC|USDT|AAPL|TSLA|MSFT|NVDA|GOOG|AMZN)\b/i) || [])[1] || null;
  const coinId = symbol ? { btc: "bitcoin", eth: "ethereum", sol: "solana", usdc: "usd-coin", usdt: "tether" }[symbol.toLowerCase()] || symbol.toLowerCase() : null;
  // A place name is whatever follows in/at/for and is capitalised, which is enough
  // for the weather bench and is never guessed silently: the filled slot is shown.
  const location = (s.match(/\b(?:in|at|for|near)\s+([A-Z][A-Za-z .'-]{2,40})/) || [])[1]?.trim() || null;
  const hours = Number((s.match(/\b(\d{1,3})\s*hours?\b/i) || [])[1] || 0) || null;
  const days = Number((s.match(/\b(\d{1,2})\s*days?\b/i) || [])[1] || 0) || null;
  return {
    query: s,
    claim: s,
    text: s,
    chain,
    chainId: chainIds[chain] || 1,
    url,
    domain,
    txHash,
    address,
    ip,
    symbol,
    coinId,
    location,
    protocol: null,
    hours,
    days,
  };
}

/** Fill a juror's declared payload template from the parsed subject. */
export function fillPayload(adapter, subject) {
  const out = {};
  const missing = [];
  for (const [key, tpl] of Object.entries(adapter.payload || {})) {
    if (typeof tpl !== "string" || !tpl.includes("{{")) {
      out[key] = tpl;
      continue;
    }
    const slot = tpl.replace(/[{}]/g, "").trim();
    const v = subject[slot];
    const decl = (adapter.slots || []).find((s) => s.param === key);
    if (v === null || v === undefined || v === "") {
      if (decl?.required) missing.push(slot);
      continue;
    }
    out[key] = v;
  }
  let endpoint = adapter.endpoint;
  if (adapter.path_template) {
    endpoint = adapter.path_template.replace(/\{\{(\w+)\}\}/g, (_, slot) => {
      const v = subject[slot];
      if (v === null || v === undefined) missing.push(slot);
      return encodeURIComponent(String(v ?? ""));
    });
  }
  return { endpoint, payload: out, missing };
}

const shortId = (h) => h.slice(2, 12);

/**
 * Open, try and close one case.
 * `emit` is called as the case progresses so the browser can stream it.
 */
export async function tryCase({ claim, env, store, data, ip, seeded = false, emit = () => {} }) {
  const openedAt = nowSec();
  const claimHash = claimHashOf(claim);
  const payer = new Payer(env.PAYER_KEY, { minGapMs: 450, retries: 2 });
  const ledgerRows = [];

  const cached = await store.cachedCase(claimHash);
  if (cached) {
    emit({ phase: "cached", case: cached });
    return cached;
  }

  const quota = await store.takeQuota(ip, 0.11, seeded ? { perIpPerHour: 1e9 } : {});
  if (!quota.ok) {
    const refused = { id: shortId(claimHash), claim, claimHash, openedAt, status: "refused", refusal: quota.reason, jurors: [], tally: { outcome: "refused", counted: 0, excluded: 0, agreementBps: 0, clusters: [], dissent: [] } };
    await store.putCase(refused);
    emit({ phase: "refused", case: refused });
    return refused;
  }

  const kase = {
    id: shortId(claimHash),
    claim,
    claimHash,
    openedAt,
    status: "open",
    seeded,
    payer: payer.address,
    subject: parseSubject(claim),
    jurors: [],
    sponsored: quota,
  };
  emit({ phase: "opened", case: kase });

  // --- juror zero: the protocol's own router -------------------------------
  const catalogue = await loadCatalogue(env);
  const routed = await payer.askRouted(claim);
  if (!routed.ok) {
    kase.status = "closed";
    kase.tally = { outcome: "no_quorum", counted: 0, excluded: 0, agreementBps: 0, dissent: [], clusters: [] };
    kase.error = `the router refused the question: ${routed.reason || routed.status}`;
    await store.putCase(kase);
    emit({ phase: "closed", case: kase });
    return kase;
  }
  ledgerRows.push(ledgerRow("router", routed, claim, null, null, seeded));
  const doc = routed.doc || {};
  kase.intent = doc.intent || null;
  kase.routerReasoning = doc.reasoning || null;
  const routerMiner = catalogue.find((m) => String(m.id) === String(doc.miner_id));
  const routerIsOurs = String(routerMiner?.wallet_address || "").toLowerCase() === OUR_WALLET;
  kase.jurors.push(
    await juror({
      seat: 0,
      kind: "router",
      id: String(doc.miner_id),
      slug: routerMiner?.slug || doc.miner_name || String(doc.miner_id),
      res: routed,
      mapping: routerMiner?.signal_mapping || null,
      ours: routerIsOurs,
      intent: doc.intent || null,
    })
  );
  emit({ phase: "juror", case: kase });

  // --- can this intent even be corroborated? -------------------------------
  const cov = data.coverage.intents[kase.intent] || {};
  const { seated, barred } = eligibleJurors(catalogue, kase.intent, null);
  const pool = seated.filter((j) => String(j.id) !== String(doc.miner_id));
  kase.bench = { eligible: seated.length, barred: barred.length, ourMinersBarred: barred.filter((b) => b.wallet === OUR_WALLET).length, pool: pool.length };
  kase.coverage = { observedCalls: cov.observed_calls ?? 0, observedUsable: cov.observed_usable ?? 0, usableRate: cov.usable_rate ?? null };

  const deadIntent = (cov.observed_calls ?? 0) >= 8 && (cov.usable_rate ?? 1) === 0;
  if (pool.length < 2 || deadIntent) {
    kase.status = "closed";
    kase.tally = tallyOfOne(kase.jurors);
    kase.noJury = deadIntent
      ? `No miner on ${kase.intent} has returned a readable verdict in ${cov.observed_calls} answers we graded off the public feed, so a jury here would only abstain. We publish that instead of charging for it.`
      : `${kase.intent} has ${pool.length} independent miner${pool.length === 1 ? "" : "s"} we can address, which is not enough to corroborate anything.`;
    await Promise.all([store.putCase(kase), store.appendLedger(ledgerRows)]);
    emit({ phase: "closed", case: kase });
    return kase;
  }

  // --- draw the rest of the jury by lot ------------------------------------
  const { seed, order } = drawLots(pool, claimHash, openedAt);
  kase.lot = { seed, order: order.map((j) => j.slug) };

  let target = PANEL_STEPS[0];
  for (const step of PANEL_STEPS) {
    target = Math.min(step, order.length + 1);
    while (kase.jurors.length < target) {
      const next = order[kase.jurors.length - 1];
      if (!next) break;
      const adapter = adapterFor(data, kase.intent, next.id) || {
        method: next.route?.method || "GET",
        endpoint: next.route?.endpoint,
        payload: { query: "{{query}}" },
        slots: [],
      };
      const filled = fillPayload(adapter, kase.subject);
      const res = await payer.askDirect(next.id, adapter.method || "GET", filled.endpoint, filled.payload);
      if (res.ok) ledgerRows.push(ledgerRow("juror", res, claim, next.slug, kase.intent, seeded));
      kase.jurors.push(
        await juror({
          seat: kase.jurors.length,
          kind: "drawn",
          id: next.id,
          slug: next.slug,
          res,
          mapping: next.mapping,
          intent: kase.intent,
          sent: { method: adapter.method || "GET", endpoint: filled.endpoint, payload: filled.payload, missing: filled.missing },
        })
      );
      kase.tally = tally(kase.jurors);
      emit({ phase: "juror", case: kase });
    }
    kase.tally = tally(kase.jurors);
    if (!shouldEscalate(kase.tally)) break;
    if (kase.jurors.length >= order.length + 1) break;
    kase.escalated = (kase.escalated || 0) + 1;
  }

  kase.tally = tally(kase.jurors);
  kase.status = "closed";
  kase.closedAt = nowSec();
  kase.spend = { paidCalls: payer.calls, usdc: Math.round(payer.spentUsdc * 1e6) / 1e6 };
  kase.panelRoot = panelRoot(kase.jurors.filter((j) => j.hashVerified && j.signalHash).map((j) => j.signalHash));

  await Promise.all([store.putCase(kase), store.appendLedger(ledgerRows)]);
  emit({ phase: "closed", case: kase });
  return kase;
}

function adapterFor(data, intent, minerId) {
  return (data.adapters.adapters || []).find((a) => a.intent_id === intent && String(a.miner_id) === String(minerId) && !a.is_ours);
}

async function juror({ seat, kind, id, slug, res, mapping, sent, ours = false, intent = null }) {
  const row = { seat, kind, minerId: id, slug, ms: res.ms, ok: res.ok, sent, ours };
  if (!res.ok) {
    row.vote = { grade: "no_answer", value: null, text: null };
    row.hashVerified = false;
    row.excluded = res.reason || `http ${res.status}`;
    return row;
  }
  const doc = res.doc || {};
  row.signalHash = doc.signal_hash || null;
  row.priceUsdc = res.priceUsdc ?? null;
  row.settlementTx = res.settlement?.transaction || null;
  row.raw = doc.result ?? null;
  const map = mapping && mapping.label_field ? mapping : inferMapping(doc.result);
  row.mapping = map;
  row.vote = readVote(doc.result, map);
  row.cmp = comparable(row.vote, intent);

  if (row.signalHash) {
    const v = await verifySignal(row.signalHash);
    row.hashVerified = v.ok;
    row.preimageBytes = v.preimageBytes;
    row.preimage = v.preimage ? v.preimage.slice(0, 1200) : null;
    row.derivedHash = v.derived;
    if (!v.ok) row.excluded = "we could not re-derive this signal hash, so the vote is not counted";
    if (!row.settlementTx && v.settlementTx) row.settlementTx = v.settlementTx;
  } else {
    row.hashVerified = false;
    row.excluded = "the node returned no signal hash for this answer";
  }
  if (!row.excluded && row.vote.grade !== "usable") row.excluded = `${row.vote.grade}, so it is reported and not counted`;
  // The protocol's router sometimes picks a miner we operate. We show that answer
  // because it is what a one-call app would have shown, then refuse to count it,
  // so no corroboration figure ever rests on our own supply.
  if (!row.excluded && ours) row.excluded = "we operate this miner, so its answer is shown but never counted";
  return row;
}

/** The router's answer carries no signal_mapping, so read the obvious fields. */
function inferMapping(result) {
  if (!result || typeof result !== "object") return { label_field: "" };
  for (const k of ["answer", "signal", "summary", "verdict", "label", "result", "value"]) if (k in result) return { label_field: k, reason_field: "reason" };
  return { label_field: "" };
}

function tallyOfOne(jurors) {
  const t = tally(jurors);
  return { ...t, outcome: jurors[0]?.hashVerified && jurors[0]?.vote?.grade === "usable" ? "single_source" : t.outcome };
}

function ledgerRow(trigger, res, claim, slug, intent, seeded) {
  const doc = res.doc || {};
  return {
    at: nowSec(),
    trigger,
    seeded: Boolean(seeded),
    intent: doc.intent || intent || null,
    miner: slug || doc.miner_name || String(doc.miner_id || ""),
    minerId: String(doc.miner_id || ""),
    priceUsdc: res.priceUsdc ?? 0.01,
    ms: res.ms,
    signalHash: doc.signal_hash || null,
    settlementTx: res.settlement?.transaction || null,
    question: String(claim).slice(0, 140),
  };
}

/**
 * Merkle root over the juror signal hashes, built the way
 * MinerCourt.verifyJuror checks it: leaves sorted ascending, and every level
 * hashes the pair in ascending order so a proof carries no index bits. An odd
 * node is carried up unchanged.
 */
export function panelRoot(hashes) {
  const ZERO = "0x" + "0".repeat(64);
  if (!hashes.length) return ZERO;
  let level = [...new Set(hashes.map((h) => h.toLowerCase()))].sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        continue;
      }
      const [a, b] = level[i] < level[i + 1] ? [level[i], level[i + 1]] : [level[i + 1], level[i]];
      next.push(keccak256(concatHex([a, b])));
    }
    level = next;
  }
  return level[0];
}

/** The proof a case page publishes so a reader can check one juror's membership. */
export function panelProof(hashes, target) {
  let level = [...new Set(hashes.map((h) => h.toLowerCase()))].sort();
  let node = target.toLowerCase();
  const proof = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        continue;
      }
      const [a, b] = level[i] < level[i + 1] ? [level[i], level[i + 1]] : [level[i + 1], level[i]];
      const parent = keccak256(concatHex([a, b]));
      if (level[i] === node || level[i + 1] === node) {
        proof.push(level[i] === node ? level[i + 1] : level[i]);
        node = parent;
      }
      next.push(parent);
    }
    level = next;
  }
  return proof;
}
