// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Reading a vote, and counting the votes.
//
// A miner's verdict is read from the field the miner itself declares in
// signal_mapping.label_field, which is the same field the protocol's validators
// grade it on. That is the only honest way to compare two miners: not string
// diffing whole JSON bodies, and not a field we picked for them.
//
// Grading a live sample of 995 answers off the public feed showed the network
// splits in two, and the split decides what this app is allowed to promise.
// Deterministic lookups answer nearly always: ONCHAIN_TX_LOOKUP 34 of 34,
// GAS_PRICE 22 of 22, WALLET_BALANCE_CHECK 14 of 14, SSL_VERIFICATION 12 of 12,
// IP_GEOLOCATION 7 of 7, STORM_ALERT 258 of 269. Open prose does not:
// WEATHER_FORECAST 0 of 92, NEWS_SEARCH 0 of 30, FACT_CHECK 0 of 18,
// WEB_SEARCH 0 of 13, CRYPTO_PRICE 22 of 122. So an abstention is a first class
// outcome here, and a hung jury is published rather than dressed up as an answer.

const ABSTAIN = /\b(unavailable|could not (be )?(read|verified|determined|found)|no (matching|data|result)|inconclusive|not available|temporarily|abstain|did not return|unable to)\b/i;

/** Resolve a dotted path, because several miners declare label_field as a.b.c */
export function dig(obj, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Turn one miner's raw result into a vote.
 * grade is one of: usable, abstained, stub, empty, no_label.
 */
export function readVote(result, mapping) {
  if (result == null) return { grade: "empty", value: null, text: null };
  const label = dig(result, mapping.label_field);
  const reason = mapping.reason_field ? dig(result, mapping.reason_field) : null;
  const confidence = mapping.confidence_field ? dig(result, mapping.confidence_field) : null;
  const text = [label, reason].filter((x) => typeof x === "string").join(" ").trim() || null;

  if (label === undefined || label === null) return { grade: "no_label", value: null, text, confidence };
  if (typeof label === "string") {
    const s = label.trim();
    if (!s) return { grade: "empty", value: null, text, confidence };
    if (ABSTAIN.test(s) || (reason && typeof reason === "string" && ABSTAIN.test(reason)))
      return { grade: "abstained", value: null, text: s, confidence };
    if (s.length < 3) return { grade: "stub", value: s, text: s, confidence };
    return { grade: "usable", value: s, text: s, confidence };
  }
  if (typeof label === "number" || typeof label === "boolean")
    return { grade: "usable", value: label, text: String(label), confidence };
  return { grade: "usable", value: label, text: text || JSON.stringify(label).slice(0, 300), confidence };
}

const NUM = /-?\d[\d,]*\.?\d*(?:[eE][-+]?\d+)?/g;
// "nothing there" is its own answer. Two miners that both report absence agree,
// even when one phrases it as a boolean and another as a status string, and
// neither is reporting the number that happens to appear in the sentence.
const NOTFOUND = /\b(not[_ ]?found|no (?:transaction|record|result|match|data|entry)|does not exist|could not be found|nothing found|unknown (?:transaction|hash))\b/i;

// Intents whose answer is a figure. On these, two miners agree when their numbers
// agree, however differently they write the sentence around them, and a unit is
// part of the figure: 0.006 gwei and 6000000 wei are the same answer.
const NUMERIC_INTENTS = new Set([
  "GAS_PRICE",
  "CRYPTO_PRICE",
  "STOCK_PRICE",
  "TOKEN_HOLDER_COUNT",
  "WALLET_BALANCE_CHECK",
  "TVL_LOOKUP",
  "CURRENCY_EXCHANGE",
  "FINANCIAL_DATA",
]);

const UNIT_SCALE = { wei: 1e-9, gwei: 1, eth: 1e9 };

/** The first figure in a sentence, normalised to gwei when a gas unit is present. */
function primaryFigure(s) {
  const m = s.match(/(-?\d[\d,]*\.?\d*)\s*(wei|gwei|eth)\b/i);
  if (m) {
    const n = Number(m[1].replace(/,/g, ""));
    const scale = UNIT_SCALE[m[2].toLowerCase()];
    if (Number.isFinite(n) && scale) return { n: n * scale, unit: "gwei" };
  }
  const pct = s.match(/(-?\d[\d,]*\.?\d*)\s*%/);
  if (pct) return { n: Number(pct[1].replace(/,/g, "")), unit: "%" };
  const usd = s.match(/\$\s*(-?\d[\d,]*\.?\d*)/);
  if (usd) return { n: Number(usd[1].replace(/,/g, "")), unit: "usd" };
  const bare = s.replace(/0x[0-9a-f]{6,}/g, " ").replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, " ").match(NUM);
  if (bare) {
    const n = Number(bare[0].replace(/,/g, ""));
    if (Number.isFinite(n)) return { n, unit: null };
  }
  return null;
}

/** Pull the comparable core out of a vote so two miners can be checked against each other. */
export function comparable(vote, intent) {
  if (vote.grade !== "usable") return null;
  const v = vote.value;
  if (typeof v === "number") return { kind: "number", n: v };
  if (typeof v === "boolean") return { kind: "bool", b: v };
  const s = String(v).toLowerCase().trim();
  const whole = `${s} ${String(vote.text || "").toLowerCase()}`;

  if (NOTFOUND.test(whole)) return { kind: "absent", t: "not found", label: s.slice(0, 120) };

  const yes = /\b(valid|safe|true|yes|supported|confirmed|clean|pass(ed)?|legit|verified|healthy|low risk)\b/;
  const no = /\b(invalid|unsafe|false|no|refuted|scam|malicious|phishing|fail(ed)?|expired|revoked|high risk)\b/;
  if (yes.test(s) && !no.test(s)) return { kind: "bool", b: true, label: s.slice(0, 60) };
  if (no.test(s) && !yes.test(s)) return { kind: "bool", b: false, label: s.slice(0, 60) };

  if (NUMERIC_INTENTS.has(intent)) {
    const fig = primaryFigure(s.length > 4 ? s : `${s} ${vote.text || ""}`);
    if (fig) return { kind: "number", n: fig.n, unit: fig.unit, label: s.slice(0, 140) };
  }

  // Identifiers are not measurements. An IP, an address or a hash quoted back in
  // a sentence must never become the number a miner is taken to have answered.
  const stripped = s
    .replace(/0x[0-9a-f]{6,}/g, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}[t0-9:.z+-]*/g, " ");

  // A whole sentence is prose, and the comparable part of prose is its words.
  // Only a short answer is read as a figure.
  if (s.length <= 40) {
    const nums = (stripped.match(NUM) || []).map((x) => Number(x.replace(/,/g, ""))).filter((x) => Number.isFinite(x));
    if (nums.length) return { kind: "number", n: nums[0], all: nums.slice(0, 6), label: s.slice(0, 120) };
  }
  const nums = (stripped.match(NUM) || []).map((x) => Number(x.replace(/,/g, ""))).filter((x) => Number.isFinite(x));
  return { kind: "text", t: s.slice(0, 200), tokens: tokenise(s), figures: nums.slice(0, 6) };
}

const STOP = new Set("the a an is are was were of in on at to for and or it its this that with by from as be been being right now currently".split(" "));
function tokenise(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}
function overlap(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

const relClose = (a, b, tol) => {
  const m = Math.max(Math.abs(a), Math.abs(b));
  if (m === 0) return true;
  return Math.abs(a - b) / m <= tol;
};

/**
 * Count the panel. Only usable votes are counted, and every excluded juror is
 * reported with the reason it was excluded.
 */
export function tally(votes, { numericTolerance = 0.05 } = {}) {
  const countable = (v) => v.vote?.grade === "usable" && v.hashVerified && v.cmp && !v.excluded;
  const counted = votes.filter(countable);
  const excluded = votes.filter((v) => !countable(v));

  if (counted.length < 2) {
    return {
      outcome: counted.length ? "single_source" : "no_quorum",
      counted: counted.length,
      excluded: excluded.length,
      agreementBps: 0,
      majority: counted[0]?.vote?.text ?? null,
      clusters: [],
      dissent: [],
    };
  }

  // Cluster the comparable cores.
  const clusters = [];
  for (const v of counted) {
    const c = v.cmp;
    let home = clusters.find((cl) => {
      if (cl.kind !== c.kind) return false;
      if (c.kind === "number") return relClose(cl.n, c.n, numericTolerance);
      if (c.kind === "bool") return cl.b === c.b;
      if (c.kind === "absent") return true;
      return overlap(cl.tokens, c.tokens) >= 0.5 || cl.t === c.t || cl.t.includes(c.t) || c.t.includes(cl.t);
    });
    if (!home) {
      home = { kind: c.kind, n: c.n, b: c.b, t: c.t, tokens: c.tokens, members: [] };
      clusters.push(home);
    }
    home.members.push(v);
  }
  clusters.sort((a, b) => b.members.length - a.members.length);

  const top = clusters[0];
  const agreementBps = Math.round((top.members.length / counted.length) * 10000);
  const dissent = clusters.slice(1).flatMap((cl) =>
    cl.members.map((m) => ({ slug: m.slug, said: m.vote.text, differs: describe(cl, top) }))
  );

  let outcome = "corroborated";
  if (agreementBps < 6000) outcome = "hung";
  else if (counted.length < 3) outcome = "thin";

  return {
    outcome,
    counted: counted.length,
    excluded: excluded.length,
    agreementBps,
    majority: top.members[0].vote.text,
    majorityValue: top.kind === "number" ? top.n : top.kind === "bool" ? top.b : top.t,
    clusters: clusters.map((cl) => ({
      kind: cl.kind,
      value: cl.kind === "number" ? cl.n : cl.kind === "bool" ? cl.b : cl.t,
      count: cl.members.length,
      slugs: cl.members.map((m) => m.slug),
    })),
    dissent,
    numericSpread: numericSpread(counted),
  };
}

function describe(cl, top) {
  if (cl.kind !== top.kind) return `answered a ${cl.kind} where the majority answered a ${top.kind}`;
  if (cl.kind === "number") {
    const d = top.n === 0 ? null : ((cl.n - top.n) / Math.abs(top.n)) * 100;
    return d === null ? `${cl.n} against ${top.n}` : `${cl.n} against ${top.n}, off by ${d.toFixed(1)}%`;
  }
  if (cl.kind === "bool") return `${cl.b ? "yes" : "no"} against ${top.b ? "yes" : "no"}`;
  if (cl.kind === "absent") return "also reported nothing found";
  if (cl.kind === "text") {
    const only = [...(cl.tokens || [])].filter((w) => !(top.tokens || new Set()).has(w)).slice(0, 6);
    return only.length ? `says ${only.join(", ")} where the majority does not` : "different wording";
  }
  return "different text";
}

function numericSpread(counted) {
  // Take the figure a miner answered with, and where the answer is prose take the
  // first figure inside it, so a price comparison still shows its error bar.
  const ns = counted
    .map((v) => (v.cmp.kind === "number" ? v.cmp.n : (v.cmp.figures || [])[0]))
    .filter((x) => typeof x === "number" && Number.isFinite(x));
  if (ns.length < 2) return null;
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  return { lo, hi, samples: ns.length, spreadPct: lo === 0 ? null : ((hi - lo) / Math.abs(lo)) * 100 };
}

/**
 * Does this panel need more jurors?
 *
 * Two reasons and no others. Below three countable votes there is nothing to
 * corroborate yet, usually because a miner errored or abstained, so we seat more.
 * Above that, only real conflict grows a jury. Silence never does, because paying
 * more miners to say nothing is not evidence.
 */
export function shouldEscalate(t) {
  if (t.counted < 3) return true;
  if (t.outcome === "hung") return true;
  return t.outcome === "corroborated" && t.agreementBps < 8000;
}
