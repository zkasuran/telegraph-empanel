// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Seating a jury.
//
// Rules, all of them checkable by a stranger:
//
//   Eligible  active, priced at the 10000 uUSDC floor, declares a label_field so
//             its verdict can be read from the field the protocol's own scorer
//             grades, has an addressable endpoint for the intent, and is NOT
//             operated by us. We run 25 of the miners on this network and wrote
//             the scoring module on all 45 intents, so our own miners are barred
//             from every jury. The bar is by WALLET, never by an id range,
//             because ids inside our range belong to other operators.
//   Drawn     by lot from the eligible pool, seeded with
//             keccak256(claimHash || openedAt). The draw is a pure function of
//             the case id, so anyone can recompute the panel from the case page
//             and check we did not pick friendly miners.
//   Seated    3 first. If the comparable votes disagree, 4 more. If they still
//             disagree, 4 more, to 11. A panel never grows because jurors
//             abstained, only because they conflicted, so silence is never
//             something we pay to chase.

import { keccak256, toHex } from "viem";

export const OUR_WALLET = "0x8b224783fe5b3c52b7db0cb9b1754f8812b75287";
export const PANEL_STEPS = [3, 7, 11];
const CATALOGUE_TTL = 600;

/** The live miner catalogue, cached briefly. Never hardcode a miner id. */
export async function loadCatalogue(env) {
  const cached = await env.EMPANEL.get("catalogue", "json");
  if (cached && Date.now() - cached.at < CATALOGUE_TTL * 1000) return cached.rows;
  const res = await fetch("https://devnode.telegraphprotocol.com/api/miners?limit=500", {
    headers: { "User-Agent": "curl/8.5.0" },
  });
  if (!res.ok) {
    if (cached) return cached.rows; // stale beats broken
    throw new Error(`catalogue ${res.status}`);
  }
  const rows = await res.json();
  await env.EMPANEL.put("catalogue", JSON.stringify({ at: Date.now(), rows }), { expirationTtl: 3600 });
  return rows;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which endpoint of this miner serves this intent, and what does its body look
 * like. Prefer the committed adapter map, fall back to reading the miner's own
 * declarations, and report the ones we cannot address rather than guessing.
 */
export function resolveEndpoint(miner, intent, adapters) {
  const fromMap = adapters?.intents?.[intent]?.jurors?.find((j) => String(j.id) === String(miner.id));
  if (fromMap?.endpoint) return { method: fromMap.method || "GET", endpoint: fromMap.endpoint, payload: fromMap.payload || {}, pathSlots: fromMap.path_slots || [], source: "map" };

  const eps = miner.endpoints || [];
  if (!eps.length) return null;
  const words = norm(intent).split(" ");
  const scored = eps.map((e) => {
    const hay = norm(`${e.path} ${e.description || ""}`);
    let score = 0;
    if (hay.includes(norm(intent))) score += 100; // names the intent outright
    for (const w of words) if (w.length > 2 && hay.includes(w)) score += 10;
    if (norm(e.path).includes(words[0])) score += 5;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || (best.score === 0 && eps.length > 1)) return null;
  return { method: best.e.method || "GET", endpoint: best.e.path, payload: {}, pathSlots: [], source: "derived" };
}

/** Everyone allowed to sit on a jury for this intent, with the reason for each exclusion. */
export function eligibleJurors(catalogue, intent, adapters) {
  const seated = [];
  const barred = [];
  for (const m of catalogue) {
    if (!(m.supported_intents || []).includes(intent)) continue;
    const wallet = String(m.wallet_address || "").toLowerCase();
    const label = m.signal_mapping?.label_field;
    let reason = null;
    if (wallet === OUR_WALLET) reason = "operated by us, barred from every jury";
    else if (m.activation_status !== "active") reason = `status ${m.activation_status}`;
    else if (Number(m.min_price_usdc) !== 10000) reason = `above the price floor at ${m.min_price_usdc}`;
    else if (!label) reason = "declares no label_field, so its verdict cannot be read";
    const route = reason ? null : resolveEndpoint(m, intent, adapters);
    if (!reason && !route) reason = "no endpoint of this miner maps to the intent";
    const row = {
      id: String(m.id),
      slug: m.slug,
      name: m.name,
      wallet,
      rank: m.scores?.[intent]?.rank ?? null,
      score: m.scores?.[intent]?.score ?? null,
      served: m.total_requests_served ?? 0,
      mapping: m.signal_mapping || {},
      route,
    };
    if (reason) barred.push({ ...row, reason });
    else seated.push(row);
  }
  return { seated, barred };
}

/**
 * Draw by lot. Deterministic in (claimHash, openedAt), so the case page can
 * publish the seed and anyone can recompute exactly this order.
 */
export function drawLots(jurors, claimHash, openedAt) {
  const seed = keccak256(new TextEncoder().encode(`${claimHash}|${openedAt}`));
  const keyed = jurors.map((j, i) => ({
    j,
    k: keccak256(new TextEncoder().encode(`${seed}|${j.id}|${i}`)),
  }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return { seed, order: keyed.map((x) => x.j) };
}

export const claimHashOf = (claim) => keccak256(new TextEncoder().encode(String(claim).trim().toLowerCase()));

export { toHex };
