// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Independent re-derivation of a Telegraph `signal_hash`.
//
// Rule, established by brute-forcing 31 live signals off
// https://devnode.telegraphprotocol.com on 2026-09-04 (31/31 match):
//
//   signal_hash = "0x" + hex( keccak256( goJSON(payload) ) )
//
// where payload is the `payload` object returned by
// GET /engine/v1/signal/{hash}, with `wallet_address` lowercased, and
// goJSON is Go encoding/json's default output for a map[string]any:
//   - keys sorted lexicographically at EVERY level
//   - no whitespace
//   - `<` `>` `&` escaped to < > &
//   - every other non-ASCII rune emitted as raw UTF-8 (no \uXXXX)
//
// The `payload` as SERVED is not the preimage: its top level comes back in
// Go struct order (intent_id, miner_slug, subnet_id, wallet_address,
// request, response, timestamp), so hashing the response bytes verbatim
// fails. Re-serialize with sorted keys.
//
// No dependency beyond a keccak256. Pass ethers' or viem's in.

/** Go encoding/json-compatible canonical serializer. */
export function goJSON(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") return JSON.stringify(v);
  if (t === "string")
    return JSON.stringify(v)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
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

/** Canonical preimage bytes for a signal payload. */
export function signalPreimage(payload) {
  const p = { ...payload };
  if (typeof p.wallet_address === "string")
    p.wallet_address = p.wallet_address.toLowerCase();
  return new TextEncoder().encode(goJSON(p));
}

/**
 * @param payload  the `payload` object from GET /engine/v1/signal/{hash}
 * @param keccak256  (Uint8Array) => 0x-prefixed hex, e.g. viem's keccak256
 */
export function deriveSignalHash(payload, keccak256) {
  return keccak256(signalPreimage(payload));
}

/** Fetch a signal and check the node's hash against our own derivation. */
export async function verifySignal(hash, keccak256, base = "https://devnode.telegraphprotocol.com") {
  const res = await fetch(`${base}/engine/v1/signal/${hash}`);
  if (!res.ok) throw new Error(`signal ${hash}: HTTP ${res.status}`);
  const doc = await res.json();
  const derived = deriveSignalHash(doc.payload, keccak256);
  return {
    ok: derived.toLowerCase() === doc.signal_hash.toLowerCase(),
    claimed: doc.signal_hash,
    derived,
    preimageBytes: signalPreimage(doc.payload).length,
    payer: doc.signal.wallet_address || null, // "" on daemon-internal signals
    settlementTx: doc.signal.tx_hash || null, // Base Sepolia x402 settlement
    miner: doc.signal.miner_slug,
    minerId: doc.signal.subnet_id,
    intent: doc.payload.intent_id || null,
    at: doc.payload.timestamp,
    doc,
  };
}
