// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Regenerates the routing data Empanel needs to seat a jury, from the two free
// router endpoints. No paid call, no wallet, no USDC.
//
//   GET /engine/v1/intents        the 45 canonical intents and their live miner counts
//   GET /api/miners?limit=500     every active miner, its endpoints and its schemas
//
// Writes, beside this file:
//   intents.json           per intent: the router's own description plus a free
//                          keyword/regex hint set derived from that description
//   adapters.json          per (intent, miner): how to call it through
//                          POST /engine/v1/ask/{minerId} with {method, endpoint, payload}
//   panel-eligibility.md   the juror rule and the per-intent juror counts
//
// Run: node data/build-data.mjs        (add --offline to reuse the cached raw pulls)
//
// Two facts the file leans on, both verified against the live node on 2026-09-04:
// the router's per-intent miner_count equals the number of active miners declaring
// that intent, and a bare fetch is rejected unless the User-Agent looks like curl.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = "https://devnode.telegraphprotocol.com";
const UA = "curl/8.5.0";

// Our own 25 miners. Compared lowercase, never by id range, because ids are not
// contiguous and a new registration would break a range test.
const OUR_WALLET = "0x8b224783fe5b3c52b7db0cb9b1754f8812b75287";

// The floor every honest juror sits on: 10000 = 0.01 USDC per call.
const PRICE_FLOOR_USDC = 10000;

const OFFLINE = process.argv.includes("--offline");
const RAW_DIR = path.join(HERE, "_raw");

async function pull(name, url) {
  const cache = path.join(RAW_DIR, `${name}.json`);
  if (OFFLINE) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const doc = await res.json();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(doc));
  return doc;
}

// ---------------------------------------------------------------- intents.json
//
// The router description is the classification contract: it is the text the node
// itself routes on. So every hint below is read out of that text and carries the
// phrase it came from, rather than being a guess about what the intent means.

const STOPWORDS = new Set(
  ("a an the and or of for to in on it its is are as be by that this these those with without from about into" +
    " than then when where which who whom what how why not no nor only just also more most other others rather" +
    " query asks ask asking user users supplies supply supplied provides provide provided names named name" +
    " specific specifically actual actually merely itself alone e g eg ie i e does do doing done qualify" +
    " requires require required request requests requesting return returns returning single one two" +
    " prefer preferred general generally distinct covering including includes include").split(/\s+/)
);

const tokens = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

const sentences = (s) =>
  s
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((x) => x.trim())
    .filter(Boolean);

// Shape hints. Left side is a phrase that has to be present in the router's own
// description before the regex is emitted, so a hint can always be traced back
// to the sentence that justified it.
const SHAPE_TRIGGERS = [
  ["transaction hash", "txHash", "0x[0-9a-fA-F]{64}"],
  ["blockchain address", "address", "0x[0-9a-fA-F]{40}"],
  ["contract address", "address", "0x[0-9a-fA-F]{40}"],
  ["ens name", "address", "[a-z0-9][a-z0-9-]*\\.eth"],
  ["ip address", "ip", "(?:\\d{1,3}\\.){3}\\d{1,3}|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}"],
  ["url", "url", "https?://[^\\s\"'<>]+"],
  ["hostname or domain", "domain", "\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}\\b"],
  ["cve identifier", "cveId", "CVE-\\d{4}-\\d{4,7}"],
  ["ticker", "symbol", "\\b[A-Z]{1,5}\\b"],
  ["cryptocurrency asset", "symbol", "\\b[A-Z]{2,6}\\b"],
  ["two currencies", "fromCurrency", "\\b[A-Z]{3}\\b"],
  ["coordinates", "lat", "-?\\d{1,3}\\.\\d+"],
  ["time window", "hours", "\\b(\\d{1,3})\\s*(?:hours?|hrs?|h)\\b"],
  ["stated time window", "days", "\\b(\\d{1,2})\\s*days?\\b"],
  ["target language", "targetLang", "\\b(?:into|to)\\s+([A-Z][a-z]{2,})\\b"],
  ["defi protocol", "protocol", "\\b[a-z][a-z0-9-]{2,}\\b"],
];

// Sentences shaped like a rule, kept verbatim so the app can show the reason it
// declined an intent rather than inventing one.
const REQUIRE_RE = /\b(?:requires?|must supply|must be|user must)\b/i;
const DENY_RE = /\b(?:do not qualify|does not qualify|not this intent|is not this|distinct from|rather than|not merely|no actual|with no)\b/i;

function intentHints(intent, idf) {
  const desc = intent.description || "";
  const low = desc.toLowerCase();
  const seen = new Map();
  for (const t of tokens(desc)) seen.set(t, (seen.get(t) || 0) + 1);
  const keywords = [...seen.entries()]
    .map(([term, n]) => ({ term, weight: Number((n * (idf.get(term) || 1)).toFixed(3)) }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, 12);

  // Two-word phrases the description actually uses. They beat single tokens on
  // the pairs that decide a route, "current conditions" against "forecast".
  const seq = low.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const phrases = new Map();
  for (let i = 0; i < seq.length - 1; i++) {
    const [a, b] = [seq[i], seq[i + 1]];
    if (STOPWORDS.has(a) || STOPWORDS.has(b) || a.length < 3 || b.length < 3) continue;
    phrases.set(`${a} ${b}`, (phrases.get(`${a} ${b}`) || 0) + 1);
  }

  const regex_hints = [];
  for (const [trigger, slot, pattern] of SHAPE_TRIGGERS) {
    if (!low.includes(trigger)) continue;
    if (regex_hints.some((h) => h.slot === slot)) continue;
    regex_hints.push({ slot, pattern, derived_from: trigger });
  }

  const sents = sentences(desc);
  const others = [];
  for (const m of desc.matchAll(/\b([A-Z][A-Z_]{4,})\b/g)) {
    if (m[1] === intent.intent_id || others.some((o) => o.intent_id === m[1])) continue;
    others.push({ intent_id: m[1], clause: sents.find((s) => s.includes(m[1])) || desc });
  }

  return {
    keywords,
    phrases: [...phrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p),
    examples: [...desc.matchAll(/['‘’“”]([^'‘’“”]{4,80})['‘’“”]/g)].map((m) => m[1].trim()),
    requirements: sents.filter((s) => REQUIRE_RE.test(s)),
    disqualifiers: sents.filter((s) => DENY_RE.test(s)),
    routes_elsewhere: others,
    regex_hints,
  };
}

function buildIntents(doc) {
  const list = doc.intents || [];
  const df = new Map();
  for (const i of list) for (const t of new Set(tokens(i.description || ""))) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(list.length / n)]));

  const intents = list.map((i) => ({
    intent_id: i.intent_id,
    intent_name: i.intent_name,
    description: i.description,
    miner_count: i.miner_count,
    routable: i.miner_count > 0,
    unroutable_reason: i.miner_count > 0 ? null : "no active miner declares this intent",
    hints: intentHints(i, idf),
  }));
  return { list, intents };
}

// --------------------------------------------------------------- adapters.json
//
// The slots an adapter may ask the app for. The first block is the canonical set
// Empanel fills from one parsed subject. The second block is four extensions we
// had to add: without them CVE_LOOKUP, LANGUAGE_TRANSLATION, CURRENCY_EXCHANGE
// and the coordinate-only weather miners have no fillable panel at all, because
// their required params are pattern-locked to a shape no canonical slot carries.
// Every extension says how the app produces it.
const SLOT_CATALOG = {
  query: { canonical: true, fill: "the visitor's submission, verbatim" },
  claim: { canonical: true, fill: "the checkable claim inside the submission" },
  text: { canonical: true, fill: "the passage the submission supplies for analysis" },
  address: { canonical: true, fill: "0x account, contract or ENS name parsed from the claim" },
  chain: { canonical: true, fill: "chain name parsed from the claim, default ethereum" },
  chainId: { canonical: true, fill: "numeric chain id for the named chain" },
  txHash: { canonical: true, fill: "0x + 64 hex parsed from the claim" },
  url: { canonical: true, fill: "absolute URL parsed from the claim" },
  domain: { canonical: true, fill: "hostname parsed from the claim or from the URL" },
  ip: { canonical: true, fill: "IPv4 or IPv6 literal parsed from the claim" },
  symbol: { canonical: true, fill: "ticker or asset name parsed from the claim" },
  coinId: { canonical: true, fill: "CoinGecko id for the named asset" },
  location: { canonical: true, fill: "place name parsed from the claim" },
  protocol: { canonical: true, fill: "DeFi protocol slug parsed from the claim" },
  hours: { canonical: true, fill: "hour window stated in the claim" },
  days: { canonical: true, fill: "day window stated in the claim" },
  cveId: { canonical: false, fill: "regex CVE-\\d{4}-\\d{4,7} over the claim", reason: "4 CVE miners pattern-check the id, so {{query}} cannot reach them" },
  lat: { canonical: false, fill: "geocode {{location}}", reason: "coordinate-only weather miners declare no place name" },
  lon: { canonical: false, fill: "geocode {{location}}", reason: "coordinate-only weather miners declare no place name" },
  targetLang: { canonical: false, fill: "target language named in the claim", reason: "translation miners need the target separately from the text" },
  sourceLang: { canonical: false, fill: "source language, when the claim names one", reason: "same" },
  langPair: { canonical: false, fill: "{{sourceLang}}|{{targetLang}}, source defaults to en", reason: "MyMemory-shaped miners take one packed pair" },
  fromCurrency: { canonical: false, fill: "ISO 4217 base code parsed from the claim", reason: "FX miners take the pair as two codes, not as prose" },
  toCurrency: { canonical: false, fill: "ISO 4217 quote code parsed from the claim", reason: "same" },
};

// Endpoints that are never an intent target. The first three are the shapes every
// service ships; the last rule is DegenLens saying so in its own description.
const BLOCKED_PATH = /^\/(?:$|health|healthz|metrics|meta|docs|openapi|redoc|status|version|favicon|robots)/i;
const BLOCKED_DESC = /not an intent target/i;

// Words that put an endpoint on an intent. These are for picking between the
// endpoints of a miner that already declares the intent, so they only have to
// separate that miner's own routes. They are the nouns these services name their
// routes after, not the router's classification text.
const ROUTE_WORDS = {
  ACADEMIC_SEARCH: ["papers", "paper", "academic", "scholar", "scholarly", "works", "journal", "citations"],
  AGENT_TASK: ["agent", "task", "chat", "completion", "generate", "act"],
  AI_TEXT_DETECTION: ["aidetect", "detect", "predict", "authorship", "aigenerated", "detection"],
  CHAT_COMPLETION: ["chat", "completion", "completions", "ask", "generate", "answer"],
  CONTENT_EXTRACTION: ["extract", "extraction", "metadata", "fields", "parse"],
  CONTENT_MODERATION: ["moderate", "moderation", "scan", "flag", "classify", "injection"],
  CONTENT_VERIFICATION: ["verify", "verification", "provenance", "integrity", "authentic", "detect"],
  CRYPTO_PRICE: ["price", "crypto", "cryptoprice", "spot", "coin", "quote"],
  CURRENCY_EXCHANGE: ["fx", "exchange", "rate", "rates", "currency", "convert", "forex", "latest"],
  CVE_LOOKUP: ["cve", "vulnerability", "vuln", "advisory"],
  DEEPFAKE_DETECTION: ["deepfake", "detectimage", "detectvideo", "detect", "face"],
  FACT_CHECK: ["factcheck", "fact", "claim", "verify", "proof", "check"],
  FINANCIAL_DATA: ["financial", "financials", "fundamentals", "market", "marketcap", "tradecontext", "data"],
  FRAUD_DETECTION: ["fraud", "risk", "scam", "anomaly", "assess", "suspicious", "riskcheck", "analyze", "verify"],
  GAME_RESULT: ["result", "game", "winner", "final", "fixture", "query", "score"],
  GAS_PRICE: ["gas", "gasprice", "fee", "fees", "basefee"],
  IMAGE_VERIFICATION: ["image", "detectimage", "manipulation", "detect", "photo"],
  IP_GEOLOCATION: ["ip", "geolocate", "geolocation", "geoip", "lookup", "locate"],
  LANGUAGE_GENERATION: ["generate", "generation", "chat", "completion", "text", "write"],
  LANGUAGE_TRANSLATION: ["translate", "translation", "langpair"],
  MEDIA_AUTHENTICITY_CHECK: ["media", "authentic", "detect", "detectimage", "detectvideo", "verify"],
  NEWS_HEADLINES: ["headlines", "headline", "news", "top"],
  NEWS_SEARCH: ["news", "search", "articles", "coverage"],
  ONCHAIN_TX_LOOKUP: ["tx", "transaction", "checktx", "txlookup", "lookup", "receipt", "onchaintxlookup"],
  RESEARCH_QUERY: ["research", "query", "search", "ask", "citations"],
  RESEARCH_SYNTHESIS: ["synthesis", "synthesise", "synthesize", "research", "summary", "proof"],
  SENTIMENT_ANALYSIS: ["sentiment", "tone", "emotion", "polarity"],
  SPORTS_SCORE: ["score", "scores", "live", "sports", "match", "query"],
  SSL_VERIFICATION: ["ssl", "sslcheck", "tls", "cert", "certificate", "issuances", "analyze"],
  STOCK_PRICE: ["stock", "stockprice", "equity", "quote", "share", "ticker"],
  STORM_ALERT: ["storm", "stormalert", "alert", "severe", "hazard", "wstorm"],
  TASK_COMPLETION: ["task", "complete", "completion", "chat", "plan", "risk"],
  TELEGRAPH_KNOWLEDGE: ["telegraph", "knowledge", "chat"],
  TEXT_CLASSIFICATION: ["classify", "classification", "label", "category", "sentiment", "scan"],
  TEXT_GENERATION: ["generate", "generation", "text", "write", "compose", "draft", "tailor"],
  TOKEN_HOLDER_COUNT: ["holders", "holder", "tokenholders", "holdercount"],
  TVL_LOOKUP: ["tvl", "locked", "protocol", "chain", "pool"],
  URL_SCAN: ["urlscan", "url", "scan", "phish", "phishing", "safebrowsing", "checkurl", "urls"],
  WALLET_BALANCE_CHECK: ["balance", "wallet", "walletbalance", "holdings", "trace"],
  WEATHER_CHECK: ["weather", "current", "conditions", "wcheck", "observation", "predict"],
  WEATHER_FORECAST: ["forecast", "weatherforecast", "wforecast", "predict", "weather"],
  WEB_SEARCH: ["websearch", "search", "web", "ask", "query"],
};

const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const pathWords = (p) =>
  String(p || "")
    .split(/[/\-_.]/)
    .map(flat)
    .filter(Boolean);

const namesIntent = (text, intentId) => new RegExp(`\\b${intentId}\\b`).test(String(text || ""));

/** Pick the endpoint a miner serves an intent from, and say why. */
function chooseEndpoint(miner, intentId) {
  const eps = (miner.endpoints || []).filter(
    (e) => !BLOCKED_PATH.test(e.path) && !BLOCKED_DESC.test(e.description || "")
  );
  if (!eps.length) return null;

  // An explicit intent name in the description beats everything else. Where a
  // miner uses that convention, endpoints naming a different intent are out.
  const explicit = eps.filter((e) => namesIntent(e.description, intentId));
  const declared = miner.supported_intents || [];
  const pool = explicit.length
    ? explicit
    : eps.filter((e) => !declared.some((o) => o !== intentId && namesIntent(e.description, o)));
  if (!pool.length) return null;

  const words = new Set(ROUTE_WORDS[intentId] || []);
  const scored = pool.map((e, i) => {
    let score = explicit.length ? 100 : 0;
    const why = [];
    if (explicit.length) why.push(`description names ${intentId}`);
    const hits = pathWords(e.path).filter((w) => words.has(w));
    if (hits.length) {
      score += 40 * hits.length;
      why.push(`path words ${hits.join(",")}`);
    }
    const dHits = [...new Set(tokens(e.description || "").map(flat))].filter((w) => words.has(w));
    if (dHits.length) {
      score += Math.min(24, 6 * dHits.length);
      why.push(`description words ${dHits.slice(0, 4).join(",")}`);
    }
    if (e.method === "GET") score += 2; // proven shape: the node turns payload into query params
    score -= i * 0.01; // declaration order breaks a dead heat
    return { ep: e, score, why: why.join("; ") };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  let rule = "no_match";
  if (explicit.length) rule = "explicit_intent_mention";
  else if (best.score > 0 && pathWords(best.ep.path).some((w) => words.has(w))) rule = "path_match";
  else if (best.score > 0) rule = "description_synonym";
  else if (pool.length === 1) rule = "single_endpoint";
  else return null;

  return {
    rule,
    evidence: best.why || `only functional endpoint: ${best.ep.method} ${best.ep.path}`,
    ep: best.ep,
    alternates: scored.slice(1).filter((s) => s.score > 0).slice(0, 2),
  };
}

// Param name to slot. Only names that carry the same meaning everywhere are here;
// anything ambiguous is settled by the param's own description first, below.
const NAME_SLOT = {
  query: "query", question: "query", q: "query", prompt: "query", search: "query",
  topic: "query", cvequery: "query", claim: "claim",
  text: "text", content: "text", passage: "text",
  address: "address", wallet: "address", account: "address", token: "address",
  contractaddress: "address", tokenaddress: "address",
  chain: "chain", network: "chain", pricechain: "chain", tvlchain: "chain",
  chainid: "chainId",
  txhash: "txHash", transactionhash: "txHash",
  url: "url", imageurl: "url", image: "url",
  domain: "domain", host: "domain", hostname: "domain",
  ip: "ip", ipaddress: "ip",
  symbol: "symbol", symbols: "symbol", ticker: "symbol", asset: "symbol",
  coinid: "coinId", ids: "coinId",
  location: "location", place: "location",
  protocol: "protocol",
  hours: "hours", forecasthours: "hours",
  days: "days", forecastdays: "days",
  lat: "lat", latitude: "lat",
  lon: "lon", lng: "lon", longitude: "lon",
  cveid: "cveId", langpair: "langPair",
  targetlanguage: "targetLang", sourcelanguage: "sourceLang",
};

const CURRENCY_INTENTS = new Set(["CURRENCY_EXCHANGE", "FINANCIAL_DATA"]);
const CLAIM_INTENTS = new Set(["FACT_CHECK", "CONTENT_VERIFICATION"]);

/** Which slot fills this param, and what settled it. */
function slotFor(name, prop, intentId) {
  const n = flat(name);
  const d = String(prop.description || "");
  const low = d.toLowerCase();

  // The description wins, because q alone means a city to one miner, a search
  // phrase to another and the text to translate to a third.
  if (/city name|location name|place to geocode|zip code|location query|city, region/.test(low))
    return { slot: "location", via: "description" };
  if (/text to translate|passage|untrusted text|authorship is to be analysed|text to analyz/.test(low))
    return { slot: "text", via: "description" };
  if (/file hash|paper id|semantic scholar/.test(low)) return null;
  if (/\bclaim\b|statement to/.test(low) && CLAIM_INTENTS.has(intentId))
    return { slot: "claim", via: "description" };
  if (/search keywords|search query|keyword/.test(low)) return { slot: "query", via: "description" };

  // A declared pattern pins the shape whatever the field is called.
  const pat = String(prop.pattern || "");
  if (/\{64\}/.test(pat)) return { slot: "txHash", via: "pattern" };
  if (/\{40\}/.test(pat)) return { slot: "address", via: "pattern" };
  if (/^\^CVE/i.test(pat)) return { slot: "cveId", via: "pattern" };

  if (n === "hash") return /transaction/.test(low) || /\{64\}/.test(pat) ? { slot: "txHash", via: "description" } : null;
  if (n === "id") return /coin|crypto/.test(low) ? { slot: "coinId", via: "description" } : null;

  // from and to are a currency pair here, a language pair there, dates elsewhere.
  if (n === "from" || n === "to" || n === "base" || n === "quote" || n === "currency" || n === "pair") {
    const cur = n === "from" || n === "base" ? "fromCurrency" : "toCurrency";
    if (/iso 4217|currency/.test(low) || CURRENCY_INTENTS.has(intentId))
      return { slot: n === "pair" ? "fromCurrency" : cur, via: "intent" };
    if (intentId === "LANGUAGE_TRANSLATION")
      return { slot: n === "from" ? "sourceLang" : "targetLang", via: "intent" };
    return null;
  }

  if (NAME_SLOT[n]) return { slot: NAME_SLOT[n], via: "name" };
  return null;
}

/** A value we can fill without asking the app, taken from the declaration. */
function literalFor(name, prop, intentId) {
  const n = flat(name);
  const d = String(prop.description || "");
  if (Array.isArray(prop.enum) && prop.enum.length === 1)
    return { value: prop.enum[0], derived_from: "enum offers one value" };
  if (Array.isArray(prop.enum) && prop.enum.includes(intentId))
    return { value: intentId, derived_from: `enum lists ${intentId}` };
  if (n === "vscurrency" || n === "vscurrencies") {
    if (Array.isArray(prop.enum)) return { value: prop.enum[0], derived_from: `enum ${JSON.stringify(prop.enum)}` };
    const m = d.match(/e\.g\.\s*([a-z]{3})/i);
    return m
      ? { value: m[1].toLowerCase(), derived_from: `example "${m[0]}"` }
      : { value: "usd", derived_from: "quote currency, USD is the one every case page reports in" };
  }
  if (n === "messages")
    return { value: [{ role: "user", content: "{{query}}" }], derived_from: "OpenAI-shaped chat body" };
  if (n === "model") {
    const eg = d.match(/e\.g\.\s*([^\s,;]+)/i);
    const named = d.match(/model id[s]?[:.,]?\s*([a-z0-9][^\s.,]*)/i);
    const raw = (eg && eg[1]) || (named && named[1]);
    const id = raw && raw.replace(/[.,;]+$/, "");
    if (id && /^[a-z0-9][a-z0-9._/:-]{2,}$/i.test(id)) return { value: id, derived_from: `description names ${id}` };
  }
  const canon = d.match(/canonical value is ['"]?([^.'"]+)/i);
  if (canon) return { value: canon[1].trim(), derived_from: canon[0].trim() };
  return null;
}

/** Endpoints a param's own description scopes it to, honouring "not used by". */
function paramScope(desc, epPaths) {
  const text = String(desc || "");
  const cut = text.search(/\bnot used (?:by|on|for)\b|\bexcept\b|\bexcluding\b/i);
  const grab = (s) => {
    const found = new Set();
    for (const m of String(s).matchAll(/\/[a-z0-9][a-z0-9\-_/{}.]*/gi)) {
      const cand = m[0].toLowerCase().replace(/[.,;:)]+$/, "");
      if (epPaths.has(cand)) found.add(cand);
    }
    return found;
  };
  const keep = grab(cut === -1 ? text : text.slice(0, cut));
  if (cut !== -1) for (const p of grab(text.slice(cut))) keep.delete(p);
  return keep;
}

const QUERYISH = new Set(["query", "claim", "text"]);
const SLOT_NAME_RANK = ["query", "question", "q", "topic", "search", "prompt", "tx_hash", "txHash", "hash", "address", "wallet", "domain", "host", "symbol", "ticker", "asset"];

/** Turn one (miner, endpoint, intent) into a payload template plus its slot list. */
function buildPayload(miner, ep, intentId) {
  const schema = miner.input_schema || {};
  const props = schema.properties || {};
  const declaredReq = new Set(schema.required || []);
  const epPaths = new Set((miner.endpoints || []).map((e) => String(e.path).toLowerCase()));
  const here = String(ep.path).toLowerCase();
  const multi = (miner.endpoints || []).filter((e) => !BLOCKED_PATH.test(e.path)).length > 1;
  const usesScoping = Object.values(props).some((p) => paramScope(p.description, epPaths).size);
  const pathParams = [...String(ep.path).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const blockers = [];
  const slots = [];
  const literals = [];

  for (const raw of pathParams) {
    const prop = props[raw] || {};
    const hit = slotFor(raw, prop, intentId) || (NAME_SLOT[flat(raw)] ? { slot: NAME_SLOT[flat(raw)], via: "name" } : null);
    if (!hit) {
      blockers.push(`path parameter {${raw}} has no canonical slot`);
      continue;
    }
    slots.push({ param: raw, slot: hit.slot, in: "path", required: true, via: hit.via, aliases: [] });
  }

  for (const [name, prop] of Object.entries(props)) {
    if (pathParams.includes(name)) continue;
    const desc = String(prop.description || "");
    const scope = paramScope(desc, epPaths);
    const req = declaredReq.has(name);
    if (scope.size && !scope.has(here)) continue;
    const aliasOf = (desc.match(/^alias for\s+([a-z_0-9]+)/i) || [])[1];
    if (aliasOf && props[aliasOf]) continue;

    const lit = literalFor(name, prop, intentId);
    const hit = slotFor(name, prop, intentId);
    if (!hit && lit) {
      literals.push({ param: name, value: lit.value, derived_from: lit.derived_from, required: req });
      continue;
    }
    if (!hit) {
      if (req) blockers.push(`required param ${name} has no canonical slot`);
      continue;
    }
    // Optional, unscoped, on a miner that scopes its other params: not ours to send.
    if (!req && multi && usesScoping && !scope.size && !QUERYISH.has(hit.slot)) continue;

    let required = req || scope.has(here);
    if (new RegExp(`optional (?:on|for) [^.]*${here}`, "i").test(desc)) required = false;
    else if (new RegExp(`required (?:on|for|alongside) [^.]*${here}`, "i").test(desc)) required = true;
    else if (/\boptional\b|\bdefaults? to\b|when omitted|when absent|if omitted|leave empty/i.test(desc)) required = false;
    if (QUERYISH.has(hit.slot) && !req) required = false;

    slots.push({
      param: name,
      slot: hit.slot,
      in: ep.method === "GET" ? "query" : "body",
      required,
      via: hit.via,
      aliases: [],
      ...(Array.isArray(prop.enum) ? { enum: prop.enum } : {}),
    });
  }
  return { slots: dedupeSlots(slots), literals, blockers, pathParams };
}

/** One param per slot, except the natural-language ones where miners disagree
 *  about the field name and sending two costs nothing. */
function dedupeSlots(slots) {
  const rank = (s) => {
    const i = SLOT_NAME_RANK.indexOf(s.param);
    return (s.in === "path" ? 0 : 1) * 100 + (s.required ? 0 : 200) + (i === -1 ? 50 : i);
  };
  const out = [];
  const groups = new Map();
  for (const s of slots) {
    if (!groups.has(s.slot)) groups.set(s.slot, []);
    groups.get(s.slot).push(s);
  }
  for (const [slot, group] of groups) {
    group.sort((a, b) => rank(a) - rank(b));
    const keep = QUERYISH.has(slot) ? group.slice(0, 2) : group.slice(0, 1);
    const dropped = group.slice(keep.length).map((s) => s.param);
    keep[0].aliases = dropped;
    out.push(...keep);
  }
  return out;
}

const PATH_PARAM_RE = /\{(\w+)\}/g;

function adapterFor(miner, intentId) {
  const pick = chooseEndpoint(miner, intentId);
  if (!pick) return { review: "no endpoint matches this intent" };
  const { slots, literals, blockers, pathParams } = buildPayload(miner, pick.ep, intentId);
  if (blockers.length) return { review: blockers.join("; ") };

  const fillable = slots.filter((s) => s.in !== "path");
  const payload = {};
  for (const s of fillable) payload[s.param] = `{{${s.slot}}}`;
  for (const l of literals) payload[l.param] = l.value;

  const notes = [];
  const desc = String(pick.ep.description || "");
  // A miner with no input_schema tells us nothing, so read the endpoint's own
  // words or leave it alone. A guessed field name is worse than a gap.
  if (!miner.input_schema) {
    const body = desc.match(/body:\s*\{\s*["'](\w+)["']/i);
    const backtick = desc.match(/pass the \w+ as `(\w+)`/i) || desc.match(/`(\w+)`/);
    const field = (body && body[1]) || (backtick && backtick[1]);
    if (field) {
      const hit = slotFor(field, {}, intentId);
      if (!hit) return { review: `no input_schema, and the field ${field} it names has no canonical slot` };
      slots.push({ param: field, slot: hit.slot, in: pick.ep.method === "GET" ? "query" : "body", required: true, via: "endpoint_description", aliases: [] });
      payload[field] = `{{${hit.slot}}}`;
      notes.push(`field name read out of the endpoint description, not from a schema`);
    } else if (/openai-compatible/i.test(desc)) {
      payload.messages = [{ role: "user", content: "{{query}}" }];
      literals.push({ param: "messages", value: payload.messages, derived_from: "description says OpenAI-compatible", required: true });
      notes.push("OpenAI-shaped body inferred from the description, no schema declared");
    } else if (/takes no parameters/i.test(desc)) {
      notes.push("endpoint takes no parameters, so it answers for its own fixed subject");
    } else {
      return { review: "no input_schema declared and the endpoint description names no field" };
    }
  } else if (!Object.keys(payload).length && !pathParams.length) {
    if (Object.keys(miner.input_schema.properties || {}).length)
      return { review: "no declared param maps to a slot, so the call would carry no subject" };
    notes.push("declares no parameters, so it answers for its own fixed subject");
  }
  for (const l of literals) notes.push(`pinned ${l.param}=${JSON.stringify(l.value).slice(0, 60)}`);
  for (const s of slots) if (s.enum) notes.push(`${s.param} is an enum, values ${JSON.stringify(s.enum).slice(0, 80)}`);

  const usedSlots = slots.map((s) => s.slot);
  const nonCanonical = [...new Set(usedSlots.filter((s) => !SLOT_CATALOG[s]?.canonical))];
  const score = (miner.scores || []).find((s) => s.intent_id === intentId);
  const label = (miner.signal_mapping || {}).label_field || null;
  const ours = String(miner.wallet_address || "").toLowerCase() === OUR_WALLET;

  const reasons = [];
  if (ours) reasons.push("our own miner, a juror cannot be us");
  if (miner.min_price_usdc !== PRICE_FLOOR_USDC) reasons.push(`price ${miner.min_price_usdc} is off the 10000 floor`);
  if (!label) reasons.push("declares no label_field, so there is no vote to read");
  if (miner.activation_status !== "active") reasons.push(`activation_status ${miner.activation_status}`);
  if (nonCanonical.includes("lat") || nonCanonical.includes("lon")) reasons.push("needs a geocode before it can be called");

  const everyRequiredFilled = !slots.some((s) => s.required && !s.slot);
  const confidence =
    (pick.rule === "explicit_intent_mention" || pick.rule === "path_match") &&
    miner.input_schema &&
    everyRequiredFilled &&
    !notes.some((n) => /inferred|read out of/.test(n))
      ? "high"
      : "medium";

  return {
    adapter: {
      intent_id: intentId,
      miner_id: miner.id,
      slug: miner.slug,
      name: miner.name,
      wallet_address: miner.wallet_address,
      is_ours: ours,
      min_price_usdc: miner.min_price_usdc,
      rank: score ? score.rank : null,
      score: score ? score.score : null,
      scored_epoch: score ? score.epoch_id : null,
      total_requests_served: Number.isFinite(miner.total_requests_served) ? miner.total_requests_served : null,
      method: pick.ep.method,
      endpoint: pick.ep.path,
      path_template: pathParams.length
        ? String(pick.ep.path).replace(PATH_PARAM_RE, (m, p) => {
            const s = slots.find((x) => x.param === p && x.in === "path");
            return s ? `{{${s.slot}}}` : m;
          })
        : null,
      payload,
      slots,
      literals,
      signal_mapping: miner.signal_mapping || null,
      match_rule: pick.rule,
      match_evidence: pick.evidence,
      confidence,
      notes,
      extension_slots: nonCanonical,
      eligible: reasons.length === 0,
      ineligible_reasons: reasons,
      alternates: pick.alternates.map((a) => {
        const b = buildPayload(miner, a.ep, intentId);
        const p = {};
        for (const s of b.slots.filter((x) => x.in !== "path")) p[s.param] = `{{${s.slot}}}`;
        for (const l of b.literals) p[l.param] = l.value;
        return { method: a.ep.method, endpoint: a.ep.path, payload: p, why: a.why };
      }),
    },
  };
}

// ----------------------------------------------------------------- assembly

function buildAdapters(miners) {
  const adapters = [];
  const needs_review = [];
  for (const m of miners) {
    const ours = String(m.wallet_address || "").toLowerCase() === OUR_WALLET;
    for (const intentId of m.supported_intents || []) {
      const r = adapterFor(m, intentId);
      if (r.adapter) {
        adapters.push(r.adapter);
        continue;
      }
      needs_review.push({
        intent_id: intentId,
        miner_id: m.id,
        slug: m.slug,
        wallet_address: m.wallet_address,
        is_ours: ours,
        min_price_usdc: m.min_price_usdc,
        label_field: (m.signal_mapping || {}).label_field || null,
        has_input_schema: !!m.input_schema,
        endpoints: (m.endpoints || [])
          .filter((e) => !BLOCKED_PATH.test(e.path) && !BLOCKED_DESC.test(e.description || ""))
          .slice(0, 8)
          .map((e) => `${e.method} ${e.path}`),
        reason: r.review,
        costs_a_juror: !ours && m.min_price_usdc === PRICE_FLOOR_USDC && !!(m.signal_mapping || {}).label_field,
      });
    }
  }
  return { adapters, needs_review };
}

const geocodeOnly = (a) => a.ineligible_reasons.length === 1 && /geocode/.test(a.ineligible_reasons[0]);

function perIntent(intents, adapters) {
  return intents.map((i) => {
    const mine = adapters.filter((a) => a.intent_id === i.intent_id);
    const jurors = mine.filter((a) => a.eligible);
    return {
      intent_id: i.intent_id,
      miner_count: i.miner_count,
      adapters: mine.length,
      jurors: jurors.length,
      geocode_gated: mine.filter(geocodeOnly).length,
      ours: mine.filter((a) => a.is_ours).length,
      high_confidence: jurors.filter((a) => a.confidence === "high").length,
      panel: jurors.length >= 11 ? 11 : jurors.length >= 7 ? 7 : jurors.length >= 3 ? 3 : jurors.length >= 1 ? 1 : 0,
    };
  });
}

function eligibilityDoc({ miners, adapters, needs_review, rows, stamp }) {
  const overFloor = miners.filter((m) => m.min_price_usdc > PRICE_FLOOR_USDC);
  const seat = (n) => rows.filter((r) => r.jurors >= n).length;
  const L = [];
  L.push("# Panel eligibility");
  L.push("");
  L.push(`Generated ${stamp} by \`node data/build-data.mjs\`. Counts are live, not hand-kept.`);
  L.push("");
  L.push("## The rule the app applies");
  L.push("");
  L.push("A miner is seated as a juror on an intent when all five hold.");
  L.push("");
  L.push(`1. \`activation_status\` is active. ${miners.filter((m) => m.activation_status === "active").length} of ${miners.length} registered miners are.`);
  L.push(`2. \`min_price_usdc\` is exactly ${PRICE_FLOOR_USDC}, one cent a call. ${miners.filter((m) => m.min_price_usdc === PRICE_FLOOR_USDC).length} miners sit on that floor.`);
  L.push(`3. It declares a \`signal_mapping.label_field\`, so there is a field to read the vote out of. ${miners.filter((m) => (m.signal_mapping || {}).label_field).length} do.`);
  L.push(`4. Its \`wallet_address\` is not ours. ${miners.filter((m) => String(m.wallet_address).toLowerCase() === OUR_WALLET).length} miners are ours, matched on the wallet in lowercase, never on an id range.`);
  L.push("5. `adapters.json` carries an addressable endpoint for that exact intent, with every required param filled by a slot or a literal.");
  L.push("");
  L.push("Above the floor, so excluded by rule 2:");
  L.push("");
  for (const m of overFloor) L.push(`- id ${m.id} \`${m.slug}\` at ${m.min_price_usdc} (${(m.min_price_usdc / 1e6).toFixed(2)} USDC a call)`);
  L.push("");
  L.push("Rule 5 is the one that bites. A miner can pass the first four and still not be callable, because it declares no input_schema, or its required param is a pool address or a deal id that no claim carries. Those sit in the `needs_review` array of `adapters.json` with the reason. " + needs_review.filter((r) => r.costs_a_juror).length + " of them would otherwise have been jurors.");
  L.push("");
  L.push("## Jurors per intent");
  L.push("");
  L.push("`declared` is the router's own miner_count. `jurors` is what survives the rule. `+geo` is jurors that need a geocode first, because the miner takes coordinates and no place name. `panel` is the largest odd panel the intent can seat.");
  L.push("");
  L.push("| intent | declared | ours | adapters | jurors | +geo | panel |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of [...rows].sort((a, b) => b.jurors - a.jurors || a.intent_id.localeCompare(b.intent_id)))
    L.push(`| ${r.intent_id} | ${r.miner_count} | ${r.ours} | ${r.adapters} | ${r.jurors} | ${r.geocode_gated} | ${r.panel || "none"} |`);
  L.push("");
  L.push("## What that seats");
  L.push("");
  L.push(`- ${seat(11)} intents seat 11 independent jurors`);
  L.push(`- ${seat(7)} seat 7`);
  L.push(`- ${seat(3)} seat 3`);
  L.push(`- ${seat(1) - seat(3)} seat only 1 or 2, so a panel there is a second opinion rather than a jury`);
  L.push(`- ${rows.length - seat(1)} seat none, including the two intents no miner declares at all`);
  L.push("");
  L.push(`Totals: ${adapters.length} (intent, miner) adapters, ${adapters.filter((a) => a.eligible).length} of them eligible jurors, across ${new Set(adapters.filter((a) => a.eligible).map((a) => a.miner_id)).size} distinct miners.`);
  L.push("");
  return L.join("\n");
}

// --------------------------------------------------------------------- main

const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const intentDoc = await pull("intents", `${NODE}/engine/v1/intents`);
const minerDoc = await pull("miners", `${NODE}/api/miners?limit=500`);
const miners = Array.isArray(minerDoc) ? minerDoc : minerDoc.miners || [];
const { list, intents } = buildIntents(intentDoc);
const { adapters, needs_review } = buildAdapters(miners);
const rows = perIntent(list, adapters);

// Self-checks. Each one has caught a real mistake in this file, so they run every
// time rather than sitting in a test nobody invokes.
const checks = [];
const declaredCount = new Map();
for (const m of miners) for (const i of m.supported_intents || []) declaredCount.set(i, (declaredCount.get(i) || 0) + 1);
checks.push([
  "router miner_count equals the miners declaring the intent",
  list.every((i) => (declaredCount.get(i.intent_id) || 0) === i.miner_count),
]);
checks.push([
  "every adapter endpoint exists on its miner",
  adapters.every((a) => {
    const m = miners.find((x) => x.id === a.miner_id);
    return m.endpoints.some((e) => e.path === a.endpoint && e.method === a.method);
  }),
]);
const slotRe = /\{\{(\w+)\}\}/g;
checks.push([
  "every slot in a payload is in the slot catalog",
  adapters.every((a) =>
    [...JSON.stringify(a.payload).matchAll(slotRe)].every((m) => Object.hasOwn(SLOT_CATALOG, m[1]))
  ),
]);
checks.push([
  "every (intent, miner) pair is either an adapter or a review",
  adapters.length + needs_review.length === miners.reduce((n, m) => n + (m.supported_intents || []).length, 0),
]);
checks.push(["no eligible juror is one of ours", !adapters.some((a) => a.eligible && a.is_ours)]);

const usedSlots = new Set();
for (const a of adapters) for (const s of a.slots) usedSlots.add(s.slot);

const intentsOut = {
  generated_at: stamp,
  source: `${NODE}/engine/v1/intents`,
  canonical_on_chain: intentDoc.canonical_on_chain,
  count: intents.length,
  unroutable: intents.filter((i) => !i.routable).map((i) => i.intent_id),
  hint_derivation:
    "keywords are the description's own terms weighted by inverse document frequency across all 45 descriptions; phrases are pairs it uses; requirements and disqualifiers are its own sentences verbatim; routes_elsewhere is every other intent it names; a regex hint is emitted only when the description contains the phrase in derived_from",
  intents,
};

const adaptersOut = {
  generated_at: stamp,
  source: `${NODE}/api/miners?limit=500`,
  call_shape: "POST /engine/v1/ask/{miner_id} with {method, endpoint, payload}, x402 paid, 0.01 USDC",
  our_wallet: OUR_WALLET,
  price_floor_usdc: PRICE_FLOOR_USDC,
  totals: {
    miners: miners.length,
    ours: miners.filter((m) => String(m.wallet_address).toLowerCase() === OUR_WALLET).length,
    pairs: adapters.length + needs_review.length,
    adapters: adapters.length,
    eligible: adapters.filter((a) => a.eligible).length,
    high_confidence: adapters.filter((a) => a.confidence === "high").length,
    needs_review: needs_review.length,
  },
  slot_catalog: Object.fromEntries(Object.entries(SLOT_CATALOG).filter(([k]) => usedSlots.has(k))),
  rules: {
    endpoint:
      "an endpoint whose description names the intent wins; then a path word match; then a description word match; then the only functional endpoint. health, metrics, meta, docs and root paths are never routed, nor is any endpoint whose description says it is not an intent target",
    slots:
      "each declared param is read off input_schema: its own description first (q means a city to one miner and the text to translate to another), then its declared pattern, then its name. A param whose description names other endpoints is only sent to those. An unmapped required param sends the pair to needs_review instead of guessing",
    required:
      "required when input_schema.required lists it, when it is a path parameter, or when its description scopes it to this endpoint. An explicit optional, default or when-omitted clause overrides that",
  },
  needs_review,
  adapters,
};

fs.writeFileSync(path.join(HERE, "intents.json"), JSON.stringify(intentsOut, null, 2) + "\n");
fs.writeFileSync(path.join(HERE, "adapters.json"), JSON.stringify(adaptersOut, null, 2) + "\n");
fs.writeFileSync(
  path.join(HERE, "panel-eligibility.md"),
  eligibilityDoc({ miners, adapters, needs_review, rows, stamp })
);

// ------------------------------------------------------------------ summary

const seat = (n) => rows.filter((r) => r.jurors >= n).length;
const eligible = adapters.filter((a) => a.eligible);
console.log(`data built ${stamp}`);
console.log(`  intents.json          ${intents.length} intents, ${intents.filter((i) => !i.routable).length} unroutable (${intentsOut.unroutable.join(", ") || "none"})`);
console.log(`  adapters.json         ${adapters.length} adapters + ${needs_review.length} needs_review over ${adaptersOut.totals.pairs} declared pairs`);
console.log(`  panel-eligibility.md  ${eligible.length} eligible jurors across ${new Set(eligible.map((a) => a.miner_id)).size} miners`);
console.log("");
console.log(`miners ${miners.length} total, ${adaptersOut.totals.ours} ours, ${miners.filter((m) => m.min_price_usdc > PRICE_FLOOR_USDC).length} above the price floor, ${miners.filter((m) => !(m.signal_mapping || {}).label_field).length} with no label_field`);
console.log(`confidence  high ${adapters.filter((a) => a.confidence === "high").length}, medium ${adapters.filter((a) => a.confidence === "medium").length}`);
console.log(`match rule  ${Object.entries(adapters.reduce((acc, a) => ((acc[a.match_rule] = (acc[a.match_rule] || 0) + 1), acc), {})).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`panels      ${seat(3)} intents seat 3 or more jurors, ${seat(7)} seat 7 or more, ${seat(11)} seat 11 or more`);
console.log(`gaps        ${needs_review.filter((r) => r.costs_a_juror).length} of ${needs_review.length} review rows cost a juror`);
console.log("");
console.log("top 12 intents by independent juror count");
for (const r of [...rows].sort((a, b) => b.jurors - a.jurors).slice(0, 12))
  console.log(`  ${String(r.jurors).padStart(2)} jurors  ${r.intent_id.padEnd(26)} declared ${String(r.miner_count).padStart(2)}  ours ${r.ours}  high-confidence ${r.high_confidence}${r.geocode_gated ? `  +${r.geocode_gated} geocode-gated` : ""}`);
console.log("");
for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
