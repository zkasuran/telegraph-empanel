// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Independent re-derivation of a Telegraph signal_hash.
//
// The node publishes {algorithm: keccak256, commitment: payload, verified: true}
// beside every signal but does not say what the preimage is. It is:
//
//   signal_hash = "0x" + keccak256( goJSON(payload) )
//
// where goJSON is Go encoding/json's output for a map: keys sorted at every
// level, no whitespace, `<` `>` `&` escaped to their \u form, every other
// non-ASCII rune left as raw UTF-8. The payload's `wallet_address` is lowercased
// first, because the API serves it EIP-55 checksummed.
//
// The trap: the payload as SERVED comes back in Go struct order, so hashing the
// bytes as they arrive fails. Re-serialise with sorted keys.
//
// Established by brute-forcing 31 live signals on 2026-09-04, 31 of 31 matching,
// and re-checked against our own paid calls. Fixtures in tools/fixtures.

import { keccak256 } from "viem";

/** Go encoding/json-compatible canonical serialiser. */
export function goJSON(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") return JSON.stringify(v);
  if (t === "string")
    return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  if (Array.isArray(v)) return "[" + v.map(goJSON).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => goJSON(k) + ":" + goJSON(v[k]))
      .join(",") +
    "}"
  );
}

/** The exact bytes the node hashed. Shown in the UI so a reader can check it. */
export function preimage(payload) {
  const p = { ...payload };
  if (typeof p.wallet_address === "string") p.wallet_address = p.wallet_address.toLowerCase();
  return goJSON(p);
}

export function derive(payload) {
  return keccak256(new TextEncoder().encode(preimage(payload)));
}

/**
 * Fetch a signal and check the node's hash against our own derivation.
 * Works on any payer's signals, not only ours, so it can audit the whole feed.
 */
export async function verifySignal(hash, node = "https://devnode.telegraphprotocol.com") {
  const res = await fetch(`${node}/engine/v1/signal/${hash}`, { headers: { "User-Agent": "curl/8.5.0" } });
  if (!res.ok) return { ok: false, reason: `signal lookup ${res.status}` };
  const doc = await res.json();
  const bytes = preimage(doc.payload);
  const derived = keccak256(new TextEncoder().encode(bytes));
  return {
    ok: derived.toLowerCase() === String(doc.signal_hash).toLowerCase(),
    claimed: doc.signal_hash,
    derived,
    preimage: bytes,
    preimageBytes: bytes.length,
    payer: doc.signal?.wallet_address || null,
    settlementTx: doc.signal?.tx_hash || null,
    miner: doc.signal?.miner_slug || null,
    minerId: doc.signal?.subnet_id || null,
    intent: doc.payload?.intent_id || null,
    at: doc.payload?.timestamp || null,
    request: doc.payload?.request ?? null,
    response: doc.payload?.response ?? null,
  };
}
