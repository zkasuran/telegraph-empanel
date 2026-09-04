// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// The x402 payer, written against the wire format rather than the SDK, because
// this runs inside a Cloudflare Worker and viem's signTypedData is the only
// dependency that is certain to work there.
//
// Flow: send the call unpaid, read the 402 challenge, sign an EIP-3009
// TransferWithAuthorization over the USDC domain, resend with the signature.
// The payer never spends gas. A facilitator broadcasts the authorization, which
// is why a browser wallet or a Worker secret can both pay with USDC alone.
//
// Two behaviours measured on the live node on 2026-09-04 and coded around here:
//
//   1. Concurrent payments from one payer are rejected with a bare 402. Five at
//      once lost two. A stagger of ~450ms between calls fixed three of three,
//      and a retry covers the rest. PAYMENTS ARE SERIALISED THROUGH ONE QUEUE.
//   2. The node pre-validates the payload against the miner's declared schema
//      and 422s on warnings that are often wrong. `acknowledge_warnings: true`
//      at the top level of the body makes the call run.
//
// A 402 or a 422 costs nothing, so retrying is free.

import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";

export const NODE = "https://devnode.telegraphprotocol.com";
export const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const UA = "curl/8.5.0";

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One payer, one queue. Every paid call in the process goes through this. */
export class Payer {
  constructor(privateKey, { minGapMs = 450, retries = 2 } = {}) {
    this.account = privateKeyToAccount(privateKey);
    this.minGapMs = minGapMs;
    this.retries = retries;
    this.tail = Promise.resolve();
    this.spentUsdc = 0;
    this.calls = 0;
  }

  get address() {
    return this.account.address;
  }

  /** Serialise onto the tail of the queue, keeping minGapMs between departures. */
  enqueue(fn) {
    const run = this.tail.then(async () => {
      await sleep(this.minGapMs);
      return fn();
    });
    // Keep the chain alive even when one call rejects.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Sign one authorization and encode the header.
   *
   * The header is not just the signature. It also echoes back the requirement
   * we chose (`accepted`) and the resource we are paying for (`resource`), and
   * the node rejects the payment with a bare 402 if either is missing, which is
   * indistinguishable from not having paid at all. Captured off the reference
   * client to get this right rather than guessed.
   */
  async sign(accept, challenge, requestUrl) {
    const now = Math.floor(Date.now() / 1000);
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const authorization = {
      from: this.account.address,
      to: accept.payTo,
      value: String(accept.amount),
      validAfter: "0",
      validBefore: String(now + (accept.maxTimeoutSeconds || 60)),
      nonce: toHex(nonceBytes),
    };
    const signature = await this.account.signTypedData({
      domain: {
        name: accept.extra.name,
        version: accept.extra.version,
        chainId: CHAIN_ID,
        verifyingContract: accept.asset,
      },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    return b64(
      JSON.stringify({
        x402Version: 2,
        payload: { authorization, signature },
        resource: {
          description: challenge?.resource?.description ?? "",
          mimeType: challenge?.resource?.mimeType ?? "application/json",
          url: requestUrl,
        },
        accepted: accept,
      })
    );
  }

  /** One paid POST. Returns {ok, status, doc, ms, settlement, reason}. */
  async paidPost(path, body) {
    return this.enqueue(async () => {
      const url = `${NODE}${path}`;
      const payload = JSON.stringify({ ...body, acknowledge_warnings: true });
      const send = (header) =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            ...(header ? { "PAYMENT-SIGNATURE": header } : {}),
          },
          body: payload,
        });

      const t0 = Date.now();
      let challenge = await send();
      if (challenge.status !== 402) {
        // Either it needs no payment or it failed before the gate.
        const text = await challenge.text();
        return {
          ok: challenge.ok,
          status: challenge.status,
          ms: Date.now() - t0,
          doc: safeJson(text),
          reason: challenge.ok ? null : trim(text),
        };
      }

      const header = challenge.headers.get("payment-required");
      if (!header) return { ok: false, status: 402, ms: Date.now() - t0, reason: "402 with no challenge header" };
      let accept;
      let decoded;
      try {
        decoded = JSON.parse(unb64(header));
        accept = (decoded.accepts || []).find((a) => a.network === NETWORK);
      } catch (e) {
        return { ok: false, status: 402, ms: Date.now() - t0, reason: `undecodable challenge: ${e}` };
      }
      if (!accept) return { ok: false, status: 402, ms: Date.now() - t0, reason: `no ${NETWORK} rail offered` };

      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (attempt) await sleep(700 * attempt);
        const res = await send(await this.sign(accept, decoded, url));
        const text = await res.text();
        if (res.status === 402) continue; // free, and usually a concurrency reject
        if (!res.ok) {
          return { ok: false, status: res.status, ms: Date.now() - t0, reason: trim(text), doc: safeJson(text) };
        }
        this.calls += 1;
        this.spentUsdc += Number(accept.amount) / 1e6;
        return {
          ok: true,
          status: 200,
          ms: Date.now() - t0,
          doc: safeJson(text),
          priceUsdc: Number(accept.amount) / 1e6,
          settlement: readSettlement(res),
        };
      }
      return { ok: false, status: 402, ms: Date.now() - t0, reason: "payment refused after retries, nothing charged" };
    });
  }

  /** Auto-routed ask. The node's own router picks the miner. */
  askRouted(query, context) {
    return this.paidPost("/engine/v1/ask", context ? { query, context } : { query });
  }

  /** Direct ask against one miner. */
  askDirect(minerId, method, endpoint, payload) {
    return this.paidPost(`/engine/v1/ask/${minerId}`, { method, endpoint, payload });
  }
}

function readSettlement(res) {
  const raw = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (!raw) return null;
  try {
    return JSON.parse(unb64(raw));
  } catch {
    return null;
  }
}

const trim = (s) => String(s || "").slice(0, 240);
const safeJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/** Free reads. No payment, no auth, CORS open, so these are cheap to lean on. */
export async function freeGet(path) {
  const res = await fetch(`${NODE}${path}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}
