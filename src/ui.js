// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Every page is server rendered from real state, then the case page streams its
// jurors in over SSE as each paid call settles. No build step, no framework.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BASE_CSS = `
:root{--bg:#0b0d10;--panel:#12161b;--line:#1e252d;--ink:#e8edf2;--dim:#8b98a5;--acc:#6ee7a8;--warn:#f0b357;--bad:#f2726f;--link:#7cc4ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 "Roboto Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:20px 18px 64px}
header.top{display:flex;flex-wrap:wrap;gap:14px;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:20px}
.brand{font-size:19px;letter-spacing:.14em;text-transform:uppercase}
.brand b{color:var(--acc)}
.tag{color:var(--dim)}
nav{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap}
.counters{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}
.pill{border:1px solid var(--line);background:var(--panel);padding:7px 11px;border-radius:3px}
.pill b{color:var(--acc);font-weight:600}
.pill.dim b{color:var(--ink)}
h1{font-size:22px;margin:0 0 6px;font-weight:600}
h2{font-size:15px;margin:26px 0 10px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em}
p{margin:8px 0}
.lede{color:var(--dim);max-width:74ch}
form.ask{display:flex;gap:8px;margin:16px 0 8px}
input[type=text]{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--ink);padding:11px 12px;border-radius:3px;font:inherit}
input[type=text]:focus{outline:none;border-color:var(--acc)}
button{background:var(--acc);color:#06231a;border:0;padding:11px 16px;border-radius:3px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 4px}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--dim);padding:6px 10px;border-radius:14px;cursor:pointer;font-size:12.5px}
.chip:hover{color:var(--ink);border-color:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.08em}
.card{border:1px solid var(--line);background:var(--panel);border-radius:4px;padding:13px 15px;margin:10px 0}
.card.zero{border-left:2px solid var(--warn)}
.card.out{opacity:.62}
.row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.seat{color:var(--dim);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase}
.said{margin:7px 0 0;white-space:pre-wrap;word-break:break-word}
.ok{color:var(--acc)}.no{color:var(--bad)}.mid{color:var(--warn)}
.mono{font-family:inherit;color:var(--dim);word-break:break-all;font-size:12px}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin:6px 0}
.bar i{display:block;height:100%;background:var(--acc)}
details{border:1px solid var(--line);border-radius:3px;padding:9px 11px;margin:8px 0;background:#0e1216}
summary{cursor:pointer;color:var(--dim)}
pre{overflow-x:auto;background:#080a0d;border:1px solid var(--line);padding:10px;border-radius:3px;font-size:12px;margin:8px 0}
footer{margin-top:44px;border-top:1px solid var(--line);padding-top:14px;color:var(--dim);font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.big{font-size:26px;font-weight:600}
.small{font-size:12px;color:var(--dim)}
`;

export function shell({ title, body, counters, ogDescription, canonical }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(ogDescription || "A jury of independent Telegraph miners, and the receipts.")}">
<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="website">
<meta property="og:description" content="${esc(ogDescription || "")}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@300;400;600&display=swap" rel="stylesheet">
<style>${BASE_CSS}</style></head><body><div class="wrap">
<header class="top">
  <span class="brand"><b>Empanel</b></span>
  <span class="tag">a jury of Telegraph miners</span>
  <nav>
    <a href="/">try a claim</a><a href="/docket">docket</a><a href="/coverage">coverage</a>
    <a href="/ledger">ledger</a><a href="/verify">verify a hash</a><a href="/chain">on chain</a>
  </nav>
</header>
${counters || ""}
${body}
<footer>
Empanel pays for every answer with x402 USDC on Base Sepolia and publishes the receipt.
We also operate 25 miners on this network and wrote the scoring module on all 45 intents, so
our own miners are barred from every jury by wallet address and the bar is checkable in the code.
<br>Source and licence: <a href="https://github.com/zkasuran/telegraph-empanel">github.com/zkasuran/telegraph-empanel</a>.
</footer></div></body></html>`;
}

export function counterBar(c) {
  return `<div class="counters">
<span class="pill">paid Telegraph calls <b>${c.paidCalls}</b></span>
<span class="pill dim">of those, opened by visitors <b>${c.visitorCalls}</b></span>
<span class="pill">USDC spent <b>$${c.usdcSpent.toFixed(2)}</b></span>
<span class="pill dim">cases tried <b>${c.cases}</b></span>
<span class="pill dim">human jurors <b>${c.humanVotes}</b></span>
<span class="pill dim">sponsored budget left today <b>$${c.budget.leftUsdc.toFixed(2)}</b></span>
</div>`;
}

export { esc };

const PRESETS = [
  "What is the current gas price on Base?",
  "Is the TLS certificate for github.com valid right now, and who issued it?",
  "What is the storm risk in Manila over the next 24 hours?",
  "How many holders does the token at 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 on base have?",
  "What is the USDC balance of 0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287 on base?",
  "Where is 8.8.8.8 located, and which network owns it?",
];

export function landing({ counters, docket, seatable }) {
  return shell({
    title: "Empanel, a jury of Telegraph miners",
    ogDescription: "Ask one question, hear back from every independent miner on the intent, and keep a receipt you can check yourself.",
    counters: counterBar(counters),
    body: `
<h1>One question. Every independent miner on the intent. One receipt.</h1>
<p class="lede">Telegraph's router answers with a single miner. Empanel takes that answer, then puts the same
question to the rest of the bench, counts only the votes whose signal hash we can re-derive ourselves, and
publishes what the jury agreed and where it split. When the jury holds, the verdict is written on Base Sepolia
where a contract can read it. We pay for every call, so you need no wallet and no account.</p>

<form class="ask" method="POST" action="/case" id="askform">
  <input type="text" name="claim" id="claim" autocomplete="off" required
    placeholder="a checkable question or claim, for example: what is the gas price on Base right now">
  <button type="submit">Empanel a jury</button>
</form>
<div class="chips">${PRESETS.map((p) => `<span class="chip" data-q="${esc(p)}">${esc(p.length > 62 ? p.slice(0, 60) + "…" : p)}</span>`).join("")}</div>
<p class="small">A case costs us up to 11 cents of testnet USDC. Caps are ${8} cases per hour per address and
$8 of sponsored calls a day, printed above so you can see what is left.</p>

<h2>Where a jury can actually be seated</h2>
<p class="lede">We graded 995 real answers off the network's own public feed. Some intents answer nearly every
time, and on others no miner has ever returned a readable verdict. Empanel refuses to charge for a jury it
knows will abstain, and says so with the numbers. <a href="/coverage">The whole table</a>.</p>
<div class="grid">
${seatable
  .slice(0, 8)
  .map(
    (s) => `<div class="card"><div class="row"><b>${esc(s.intent)}</b><span class="small">${s.jurors} jurors</span></div>
<div class="bar"><i style="width:${Math.round((s.rate ?? 0) * 100)}%"></i></div>
<span class="small">${s.observed ? `${s.usable} of ${s.observed} observed answers were readable` : "not yet observed in the feed"}</span></div>`
  )
  .join("")}
</div>

<h2>Recent cases</h2>
${docketTable(docket.slice(0, 12))}
<script>
document.querySelectorAll('.chip').forEach(function(c){c.addEventListener('click',function(){
  document.getElementById('claim').value=c.dataset.q;document.getElementById('askform').submit();});});
</script>`,
  });
}

export function docketTable(rows) {
  if (!rows.length) return `<p class="small">No cases yet.</p>`;
  return `<table><thead><tr><th>case</th><th>claim</th><th>intent</th><th>outcome</th><th>jury</th><th>on chain</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr>
<td><a href="/c/${esc(r.id)}">${esc(r.id)}</a></td>
<td>${esc(r.claim)}</td>
<td class="small">${esc(r.intent || "-")}</td>
<td>${outcomeChip(r.outcome, r.agreementBps)}</td>
<td class="small">${r.counted} of ${r.panel} counted${r.humanVotes ? `, ${r.humanVotes} human` : ""}</td>
<td class="small">${r.onchain ? `<a href="https://base-sepolia.blockscout.com/tx/${esc(r.onchain)}">verdict</a>` : "-"}</td>
</tr>`
  )
  .join("")}
</tbody></table>`;
}

export function outcomeChip(outcome, bps) {
  const pct = bps ? ` ${(bps / 100).toFixed(0)}%` : "";
  const map = {
    corroborated: `<span class="ok">corroborated${pct}</span>`,
    hung: `<span class="bad no">hung jury${pct}</span>`,
    thin: `<span class="mid">thin${pct}</span>`,
    single_source: `<span class="mid">one source only</span>`,
    no_quorum: `<span class="no">no quorum</span>`,
    refused: `<span class="mid">refused</span>`,
  };
  return map[outcome] || `<span class="small">${esc(outcome || "open")}</span>`;
}

export function jurorCard(j) {
  const v = j.vote || {};
  const chip = j.hashVerified
    ? `<span class="ok">hash re-derived</span>`
    : `<span class="no">hash not re-derived</span>`;
  const cls = j.excluded ? "card out" : j.seat === 0 ? "card zero" : "card";
  return `<div class="${cls}">
<div class="row">
  <span class="seat">${j.seat === 0 ? "juror zero, the protocol's own router" : `juror ${j.seat}, drawn by lot`}</span>
  <b>${esc(j.slug)}</b>
  <span class="small">#${esc(j.minerId)}</span>
  <span class="small">${j.ms} ms</span>
  ${j.ours ? `<span class="mid">we operate this miner</span>` : ""}
  ${j.ok ? chip : `<span class="no">no answer</span>`}
  ${j.settlementTx ? `<a class="small" href="https://base-sepolia.blockscout.com/tx/${esc(j.settlementTx)}">payment</a>` : ""}
</div>
${j.seat === 0 ? `<div class="small">This is exactly what a one-call app would have shown you.</div>` : ""}
${v.text ? `<p class="said">${esc(String(v.text).slice(0, 900))}</p>` : ""}
${j.excluded ? `<div class="small no">not counted: ${esc(j.excluded)}</div>` : ""}
${j.sent ? `<details><summary>what we sent, and the field we read</summary><pre>${esc(JSON.stringify({ method: j.sent.method, endpoint: j.sent.endpoint, payload: j.sent.payload, label_field: j.mapping?.label_field }, null, 1))}</pre>${
    j.sent.missing?.length ? `<div class="small mid">slots this miner asked for that the claim did not contain: ${esc(j.sent.missing.join(", "))}</div>` : ""
  }</details>` : ""}
${j.preimage ? `<details><summary>verify this answer yourself</summary>
<div class="small">keccak256 of these exact bytes is the hash the node published. Keys sorted at every level, wallet lowercased, angle brackets and ampersands escaped.</div>
<pre>${esc(j.preimage)}${j.preimageBytes > 1200 ? "\n… " + (j.preimageBytes - 1200) + " more bytes" : ""}</pre>
<div class="mono">node says   ${esc(j.signalHash)}<br>we compute  ${esc(j.derivedHash || "-")}</div>
<div class="small"><a href="/verify?hash=${esc(j.signalHash)}">re-run this check</a> or paste any other app's signal hash</div>
</details>` : ""}
</div>`;
}

export function casePage({ kase, counters, host }) {
  const t = kase.tally || {};
  const shareText = `Empanel put "${String(kase.claim).slice(0, 90)}" to ${kase.jurors?.length || 0} independent Telegraph miners. ${
    t.outcome === "corroborated" ? `${t.counted} agreed, ${(t.agreementBps / 100).toFixed(0)}%.` : t.outcome === "hung" ? "The jury hung." : ""
  } @Telegraphprotoc`;
  const shareUrl = `https://${host}/c/${kase.id}`;
  return shell({
    title: `case ${kase.id}: ${String(kase.claim).slice(0, 70)}`,
    ogDescription: shareText,
    canonical: shareUrl,
    counters: counterBar(counters),
    body: `
<h1>${esc(kase.claim)}</h1>
<div class="row small">
  <span>case <b>${esc(kase.id)}</b></span>
  <span>intent <b>${esc(kase.intent || "unclassified")}</b></span>
  ${kase.spend ? `<span>${kase.spend.paidCalls} paid calls, $${kase.spend.usdc.toFixed(2)}</span>` : ""}
  ${kase.servedFromCache ? `<span class="mid">served from cache, ${kase.cachedAgeSec}s old, no new call billed</span>` : ""}
</div>

${kase.refusal ? `<div class="card zero"><b>Refused.</b> ${esc(kase.refusal)}</div>` : ""}
${kase.noJury ? `<div class="card zero"><b>No jury seated.</b> ${esc(kase.noJury)}</div>` : ""}

${t.outcome ? `<h2>the tally</h2>
<div class="card">
  <div class="row"><span class="big">${outcomeChip(t.outcome, t.agreementBps)}</span>
  <span class="small">${t.counted} votes counted, ${t.excluded} reported and not counted</span></div>
  ${t.agreementBps ? `<div class="bar"><i style="width:${Math.round(t.agreementBps / 100)}%"></i></div>` : ""}
  ${t.majority ? `<p class="said">${esc(String(t.majority).slice(0, 700))}</p>` : ""}
  ${t.numericSpread && t.numericSpread.spreadPct !== null ? `<div class="small">the numbers ranged ${t.numericSpread.lo} to ${t.numericSpread.hi}, a spread of ${t.numericSpread.spreadPct.toFixed(1)}%</div>` : ""}
</div>` : ""}

${(t.dissent || []).length ? `<h2>where the jury split</h2>
${t.dissent.map((d) => `<div class="card"><div class="row"><b>${esc(d.slug)}</b><span class="small">${esc(d.differs)}</span></div><p class="said">${esc(String(d.said || "").slice(0, 500))}</p></div>`).join("")}` : ""}

<h2>the jury</h2>
${(kase.jurors || []).map(jurorCard).join("")}

${kase.lot ? `<details><summary>how this jury was drawn</summary>
<div class="small">Seat 0 is whichever miner the protocol's own router chose. The rest were drawn by lot from every
eligible miner on the intent, seeded with keccak256 of the claim hash and the case's open time, so the order is
a pure function of this case and anyone can recompute it. ${kase.bench.ourMinersBarred} of our own miners were
barred from this bench.</div>
<pre>seed  ${esc(kase.lot.seed)}
order ${esc(kase.lot.order.join(" → "))}</pre></details>` : ""}

${kase.panelRoot ? `<details><summary>the panel root written on chain</summary>
<div class="small">A Merkle root over the sorted signal hashes of the jurors we counted. One word on chain
commits the whole panel, so a verdict quoted later is still checkable.</div>
<pre>${esc(kase.panelRoot)}</pre></details>` : ""}

${kase.onchain?.verdictTx ? `<div class="card"><div class="row"><b>Written to the register on Base Sepolia.</b>
<a class="small" href="https://base-sepolia.blockscout.com/tx/${esc(kase.onchain.verdictTx)}">the transaction</a></div>
<div class="small">A contract can now read this with
<span class="mono">latestAnswer(${esc(kase.claimHash.slice(0, 14))}…)</span> and act on it, or refuse to.
Verdict ${kase.onchain.verdict}, confidence ${((kase.onchain.confidenceBp || 0) / 100).toFixed(0)}%, block ${kase.onchain.block}.</div></div>` : ""}
${kase.onchainError ? `<div class="card zero"><div class="small">The register write failed: ${esc(kase.onchainError)}</div></div>` : ""}

${humanBlock(kase)}
<div class="row" style="margin-top:18px">
<a class="chip" href="https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}">post this case</a>
<a class="chip" href="/case?claim=${encodeURIComponent(kase.claim)}&retry=1">try it again</a>
<a class="chip" href="/docket">the docket</a>
</div>`,
  });
}

function humanBlock(kase) {
  const h = kase.human || { agree: 0, disagree: 0 };
  if (!kase.tally || kase.noJury) return "";
  return `<h2>you be the last juror</h2>
<div class="card">
<p class="small">The machines have voted. If enough people disagree with them, Empanel appeals: it spends
1.00 USDC from its on-chain escrow to open a real ERC-8183 job so a miner answers again through the on-chain
rail, and that answer lands in our contract as the record. No wallet needed to vote.</p>
<div class="row">
<form method="POST" action="/vote" style="display:inline"><input type="hidden" name="id" value="${esc(kase.id)}"><input type="hidden" name="agree" value="1"><button class="ghost" type="submit">the jury got it right (${h.agree})</button></form>
<form method="POST" action="/vote" style="display:inline"><input type="hidden" name="id" value="${esc(kase.id)}"><input type="hidden" name="agree" value="0"><button class="ghost" type="submit">the jury got it wrong (${h.disagree})</button></form>
</div>
${kase.appeal ? `<div class="small ok" style="margin-top:8px">Appealed. job ${kase.appeal.jobId}, <a href="https://base-sepolia.blockscout.com/tx/${esc(kase.appeal.createTx)}">createJob</a>${kase.appeal.answeredTx ? `, <a href="https://base-sepolia.blockscout.com/tx/${esc(kase.appeal.answeredTx)}">answered on chain</a>` : ", waiting for the protocol to settle it"}</div>` : ""}
</div>`;
}

export function ledgerPage({ counters, led, payer }) {
  return shell({
    title: "Empanel ledger, every paid call",
    counters: counterBar(counters),
    body: `
<h1>Every paid call this app has made</h1>
<p class="lede">The protocol has no app id and no API key, so the only honest measure of "calls made by this
application" is the payer wallet. Ours is <span class="mono">${esc(payer)}</span>. Two independent counts, and
you can run both yourself: the USDC transfers from that wallet to the Telegraph Diamond on Base Sepolia, and the
node's own public signal feed filtered to that payer.</p>
<div class="counters">
<span class="pill">rows here <b>${led.rows.length}</b></span>
<span class="pill">paid calls <b>${led.calls}</b></span>
<span class="pill">USDC <b>$${led.usdc.toFixed(2)}</b></span>
</div>
<p class="small">
<a href="https://base-sepolia.blockscout.com/address/${esc(payer)}?tab=token_transfers">count the settlements on chain</a>
&nbsp;·&nbsp;<a href="/api/evidence">our own reconciliation, as JSON</a>
&nbsp;·&nbsp;<a href="https://devnode.telegraphprotocol.com/daemon/api/questions?source=user&limit=100">the node's public feed</a>
</p>
<table><thead><tr><th>when</th><th>why</th><th>intent</th><th>miner</th><th>ms</th><th>signal</th><th>settlement</th></tr></thead><tbody>
${led.rows
  .slice(0, 250)
  .map(
    (r) => `<tr><td class="small">${new Date(r.at * 1000).toISOString().slice(5, 19).replace("T", " ")}</td>
<td class="small">${esc(r.trigger)}</td><td class="small">${esc(r.intent || "-")}</td><td>${esc(r.miner)}</td>
<td class="small">${r.ms}</td>
<td class="small">${r.signalHash ? `<a href="/verify?hash=${esc(r.signalHash)}">${esc(r.signalHash.slice(0, 10))}</a>` : "-"}</td>
<td class="small">${r.settlementTx ? `<a href="https://base-sepolia.blockscout.com/tx/${esc(r.settlementTx)}">${esc(r.settlementTx.slice(0, 10))}</a>` : "-"}</td></tr>`
  )
  .join("")}
</tbody></table>`,
  });
}

export function coveragePage({ counters, rows }) {
  const dead = rows.filter((r) => r.observed >= 8 && r.rate === 0);
  return shell({
    title: "Empanel coverage, where a jury can be seated",
    counters: counterBar(counters),
    body: `
<h1>Where this network can be corroborated, and where it cannot</h1>
<p class="lede">We graded 995 real answers taken from the node's own public feed, reading each miner's verdict out
of the field that miner declares and the protocol's validators grade. An answer counts as readable when that
field holds something a second miner could be checked against. Nothing here is our opinion of a miner, and none
of these calls were ours: it is the network answering other people.</p>
<p class="lede">Empanel will not seat a jury on the ${dead.length} intents at the bottom, where nothing readable
has ever come back. Charging a visitor to watch eleven miners abstain is not a product.</p>
<table><thead><tr><th>intent</th><th>independent jurors</th><th>observed answers</th><th>readable</th><th>rate</th><th>empanel</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><td>${esc(r.intent)}</td><td class="small">${r.jurors}</td><td class="small">${r.observed || "-"}</td>
<td class="small">${r.observed ? r.usable : "-"}</td>
<td>${r.rate === null ? '<span class="small">unobserved</span>' : r.rate >= 0.7 ? `<span class="ok">${(r.rate * 100).toFixed(0)}%</span>` : r.rate >= 0.4 ? `<span class="mid">${(r.rate * 100).toFixed(0)}%</span>` : `<span class="no">${(r.rate * 100).toFixed(0)}%</span>`}</td>
<td class="small">${r.jurors < 3 ? "too few jurors" : r.observed >= 8 && r.rate === 0 ? "refused, published instead" : r.rate === null ? "seats, unproven" : "seats"}</td></tr>`
  )
  .join("")}
</tbody></table>`,
  });
}

export function verifyPage({ counters, hash, result }) {
  return shell({
    title: "Empanel, verify any Telegraph signal hash",
    counters: counterBar(counters),
    body: `
<h1>Re-derive any signal hash on this network</h1>
<p class="lede">Telegraph publishes a hash beside every answer and tells you the algorithm is keccak256 over the
payload, but not what the preimage is. It is Go's own JSON encoding of the payload: keys sorted at every level,
the wallet lowercased, angle brackets and ampersands escaped, everything else raw UTF-8. The payload as served
arrives in struct order, so hashing the bytes you receive fails. This page recomputes it from scratch. It works
on anyone's signals, not just ours.</p>
<form class="ask" method="GET" action="/verify">
<input type="text" name="hash" value="${esc(hash || "")}" placeholder="0x… a signal hash from any app on this network">
<button type="submit">re-derive it</button></form>
${
  result
    ? result.ok === undefined
      ? `<div class="card zero">${esc(result.reason || "not found")}</div>`
      : `<div class="card">
<div class="row"><span class="big">${result.ok ? '<span class="ok">reproduced</span>' : '<span class="no">does not reproduce</span>'}</span>
<span class="small">${result.preimageBytes} bytes of preimage</span></div>
<div class="mono">node says   ${esc(result.claimed)}<br>we compute  ${esc(result.derived)}</div>
<table><tbody>
<tr><th>payer</th><td class="mono">${esc(result.payer || "daemon generated, unbilled")}</td></tr>
<tr><th>miner</th><td>${esc(result.miner || "-")} <span class="small">#${esc(result.minerId || "")}</span></td></tr>
<tr><th>intent</th><td>${esc(result.intent || "-")}</td></tr>
<tr><th>asked</th><td>${esc(String(result.request || "").slice(0, 300))}</td></tr>
<tr><th>settlement</th><td class="small">${result.settlementTx ? `<a href="https://base-sepolia.blockscout.com/tx/${esc(result.settlementTx)}">${esc(result.settlementTx)}</a>` : "none recorded on this signal"}</td></tr>
</tbody></table>
<details><summary>the exact preimage bytes</summary><pre>${esc(String(result.preimage || "").slice(0, 4000))}</pre></details>
</div>`
    : `<p class="small">Try one of ours, or paste a hash out of
<a href="https://devnode.telegraphprotocol.com/daemon/api/questions?limit=20">the public feed</a>.</p>`
}`,
  });
}

export function chainPage({ counters, chain }) {
  return shell({
    title: "Empanel on chain",
    counters: counterBar(counters),
    body: `
<h1>What Empanel writes on Base Sepolia</h1>
<p class="lede">A contract cannot make an HTTP request, so the only way a miner's answer reaches contract storage
is the protocol's own ERC-8183 job rail. That rail was idle when we started: 33 jobs all time and nothing created
by anyone since 3 September. A verdict is committed to <b>MinerCourt</b>, and <b>Gate</b> is the smallest contract
that shows why that matters, acting only while a panel still says the claim holds.</p>
<div class="grid">
<div class="card"><div class="small">MinerCourt</div><div class="mono">${esc(chain.court)}</div>
<div class="small">${chain.caseCount} verdicts, ${chain.appealCount} appeals answered on chain</div></div>
<div class="card"><div class="small">Gate</div><div class="mono">${esc(chain.gate)}</div>
<div class="small">acted ${chain.actions} times, floor ${chain.minConfidenceBp / 100}% confidence</div></div>
<div class="card"><div class="small">our escrow inside the Diamond</div><div class="big">$${(chain.escrow / 1e6).toFixed(2)}</div>
<div class="small">1.00 USDC per appeal, and escrow is one way</div></div>
<div class="card"><div class="small">jobs on this network, all time</div><div class="big">${chain.jobCount}</div>
<div class="small">${chain.ours} of them are ours</div></div>
</div>
<h2>the pair that makes the point</h2>
<p class="lede">The same gate, the same call, two outcomes decided by what the jury found.</p>
<table><tbody>
<tr><th>acted</th><td class="small"><a href="https://base-sepolia.blockscout.com/tx/${esc(chain.actedTx)}">${esc(chain.actedTx)}</a></td></tr>
<tr><th>refused</th><td class="small"><a href="https://base-sepolia.blockscout.com/tx/${esc(chain.refusedTx)}">${esc(chain.refusedTx)}</a> reverted NotSupported(3)</td></tr>
</tbody></table>
<p class="small">Contracts, ABI and every reproducing command:
<a href="https://github.com/zkasuran/telegraph-empanel/tree/main/contracts">contracts/README.md</a></p>`,
  });
}
