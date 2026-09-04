// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Everything the app remembers lives in one KV namespace. Cases and the ledger
// are append-only. The cache exists so nobody can run our paid-call counter up
// by refreshing a page, and the quota exists because the payer key is ours.

const nowSec = () => Math.floor(Date.now() / 1000);

// How long a corroborated answer stays true enough to serve from cache, per
// intent, in seconds. A gas price goes stale in a minute, a certificate does not.
const TTL = {
  GAS_PRICE: 60,
  CRYPTO_PRICE: 60,
  STOCK_PRICE: 120,
  CURRENCY_EXCHANGE: 300,
  WALLET_BALANCE_CHECK: 120,
  ONCHAIN_TX_LOOKUP: 86400,
  TOKEN_HOLDER_COUNT: 3600,
  TVL_LOOKUP: 900,
  STORM_ALERT: 900,
  WEATHER_FORECAST: 1800,
  WEATHER_CHECK: 900,
  SSL_VERIFICATION: 3600,
  IP_GEOLOCATION: 86400,
  CVE_LOOKUP: 86400,
  URL_SCAN: 3600,
  FRAUD_DETECTION: 3600,
  default: 600,
};

export const ttlFor = (intent) => TTL[intent] ?? TTL.default;

export class Store {
  constructor(kv) {
    this.kv = kv;
  }

  // --- cases ---------------------------------------------------------------

  caseKey(id) {
    return `case:${id}`;
  }

  async putCase(c) {
    await this.kv.put(this.caseKey(c.id), JSON.stringify(c));
    await this.pushDocket(c);
    // Only a case that actually produced a jury is worth serving again. A failed
    // payment or an empty panel must never be cached, or a transient outage
    // becomes the permanent answer to that claim.
    const worthCaching = ["corroborated", "hung", "thin", "single_source"].includes(c.tally?.outcome);
    if (c.status === "closed" && worthCaching)
      await this.kv.put(`cache:${c.claimHash}`, JSON.stringify({ id: c.id, at: nowSec(), intent: c.intent }), { expirationTtl: ttlFor(c.intent) });
  }

  getCase(id) {
    return this.kv.get(this.caseKey(id), "json");
  }

  /** A recently answered identical claim, so a refresh costs nothing. */
  async cachedCase(claimHash) {
    const hit = await this.kv.get(`cache:${claimHash}`, "json");
    if (!hit) return null;
    const c = await this.getCase(hit.id);
    if (!c) return null;
    return { ...c, servedFromCache: true, cachedAgeSec: nowSec() - hit.at };
  }

  async pushDocket(c) {
    const docket = (await this.kv.get("docket", "json")) || [];
    const row = {
      id: c.id,
      claim: c.claim.slice(0, 160),
      intent: c.intent,
      outcome: c.tally?.outcome ?? c.status,
      agreementBps: c.tally?.agreementBps ?? 0,
      panel: c.jurors?.length ?? 0,
      counted: c.tally?.counted ?? 0,
      at: c.openedAt,
      humanVotes: c.human ? c.human.agree + c.human.disagree : 0,
      onchain: c.onchain?.verdictTx ?? null,
    };
    const next = [row, ...docket.filter((d) => d.id !== c.id)].slice(0, 300);
    await this.kv.put("docket", JSON.stringify(next));
  }

  async docket(limit = 60) {
    const d = (await this.kv.get("docket", "json")) || [];
    return d.slice(0, limit);
  }

  // --- the paid-call ledger ------------------------------------------------

  /**
   * One row per paid call, with what triggered it. This is the honest answer to
   * "how many Telegraph calls did your app really make", and every row names a
   * real question and a real miner.
   */
  async appendLedger(rows) {
    if (!rows.length) return;
    const led = (await this.kv.get("ledger", "json")) || { calls: 0, usdc: 0, rows: [] };
    led.calls += rows.length;
    led.usdc = Math.round((led.usdc + rows.reduce((s, r) => s + (r.priceUsdc || 0), 0)) * 1e6) / 1e6;
    led.rows = [...rows, ...led.rows].slice(0, 1500);
    await this.kv.put("ledger", JSON.stringify(led));
  }

  async ledger() {
    return (await this.kv.get("ledger", "json")) || { calls: 0, usdc: 0, rows: [] };
  }

  /** Author-seeded cases are counted on their own line, never folded into visitor use. */
  async split() {
    const led = await this.ledger();
    const seeded = led.rows.filter((r) => r.seeded).length;
    return { total: led.calls, seeded, visitor: Math.max(0, led.calls - seeded) };
  }

  // --- sponsored quota ----------------------------------------------------

  /**
   * We pay, so a visitor cannot open unlimited cases. Both caps are printed on
   * the page rather than hidden, and the app refuses out loud when one is hit.
   */
  async takeQuota(ip, cost, { perIpPerHour = 8, globalPerDayUsdc = 8 } = {}) {
    const hour = Math.floor(nowSec() / 3600);
    const day = Math.floor(nowSec() / 86400);
    const ipKey = `q:ip:${hour}:${ip}`;
    const dayKey = `q:day:${day}`;
    const used = Number((await this.kv.get(ipKey)) || 0);
    const spent = Number((await this.kv.get(dayKey)) || 0);
    if (used >= perIpPerHour)
      return { ok: false, reason: `this address has opened ${used} cases in the last hour, which is the cap`, retryInSec: 3600 - (nowSec() % 3600) };
    if (spent + cost > globalPerDayUsdc)
      return { ok: false, reason: `today's sponsored budget of $${globalPerDayUsdc} is spent, $${(globalPerDayUsdc - spent).toFixed(2)} left`, retryInSec: 86400 - (nowSec() % 86400) };
    await this.kv.put(ipKey, String(used + 1), { expirationTtl: 7200 });
    await this.kv.put(dayKey, String(Math.round((spent + cost) * 1e6) / 1e6), { expirationTtl: 172800 });
    return { ok: true, ipCasesThisHour: used + 1, budgetLeftUsdc: Math.round((globalPerDayUsdc - spent - cost) * 100) / 100 };
  }

  async quotaState({ globalPerDayUsdc = 8 } = {}) {
    const day = Math.floor(nowSec() / 86400);
    const spent = Number((await this.kv.get(`q:day:${day}`)) || 0);
    return { spentUsdc: spent, budgetUsdc: globalPerDayUsdc, leftUsdc: Math.round((globalPerDayUsdc - spent) * 100) / 100 };
  }

  // --- human jurors --------------------------------------------------------

  /** One vote per visitor per case, keyed by a salted hash so we store no address. */
  async recordVote(caseId, voterHash, agree) {
    const key = `vote:${caseId}:${voterHash}`;
    if (await this.kv.get(key)) return { ok: false, reason: "you have already voted on this case" };
    await this.kv.put(key, agree ? "1" : "0", { expirationTtl: 2592000 });
    const c = await this.getCase(caseId);
    if (!c) return { ok: false, reason: "unknown case" };
    c.human = c.human || { agree: 0, disagree: 0 };
    if (agree) c.human.agree += 1;
    else c.human.disagree += 1;
    await this.putCase(c);
    return { ok: true, human: c.human, case: c };
  }

  async counters() {
    const [led, doc] = await Promise.all([this.ledger(), this.docket(300)]);
    const voters = doc.reduce((s, d) => s + (d.humanVotes || 0), 0);
    const seededCalls = led.rows.filter((r) => r.seeded).length;
    return {
      paidCalls: led.calls,
      seededCalls,
      visitorCalls: Math.max(0, led.calls - seededCalls),
      usdcSpent: led.usdc,
      cases: doc.length,
      humanVotes: voters,
    };
  }
}

export { nowSec };
