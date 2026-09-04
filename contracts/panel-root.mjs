// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// Panel roots for MinerCourt. Leaves are the jurors' own signal hashes, sorted
// ascending, hashed in sorted pairs at every level with an odd node promoted
// unchanged. That is the format MinerCourt.verifyJuror expects.
//
// Every leaf is re-derived from the fixture payload with tools/signal-hash.mjs
// before it goes in, so a leaf is a hash we recomputed and not one we were told.
//
// Usage: node panel-root.mjs [--json]

import { readFileSync, readdirSync } from "node:fs";
import { keccak256, toHex, encodePacked } from "viem";
import { deriveSignalHash } from "../tools/signal-hash.mjs";

const FIXTURES = new URL("../tools/fixtures/", import.meta.url);
const k256 = (bytes) => keccak256(bytes);

/** The two seeded cases, and the fixture signals that make up each panel. */
export const PANELS = [
  {
    name: "morpho-safety",
    claim:
      "Morpho on Base has no documented scam or phishing association and app.morpho.org is safe to visit.",
    verdict: 1, // supported
    confidenceBp: 6000, // lowest confidence any juror reported: sarzops 0.60
    jurors: [
      "s8_direct_tavily.json",
      "s12_direct_sarzops-transaction-risk.json",
      "s14_direct_netwire-url-scan.json",
    ],
  },
  {
    name: "india-cricket",
    claim: "India won its most recent cricket match.",
    verdict: 3, // hung
    confidenceBp: 5000, // lowest confidence any juror reported: sportwire 0.50
    jurors: [
      "s22_direct_sportwire-game-result.json",
      "s19_direct_fourcast-sports-intelligence.json",
      "s17_direct_scorewire-oracle.json",
    ],
  },
];

/** Read a fixture and check the node's signal_hash against our own derivation. */
export function leafOf(file) {
  const doc = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
  const derived = deriveSignalHash(doc.payload, k256);
  const claimed = doc.signal_hash.toLowerCase();
  if (derived.toLowerCase() !== claimed)
    throw new Error(`${file}: derived ${derived} but the node says ${claimed}`);
  return { file, miner: doc.signal.miner_slug, hash: claimed };
}

const pair = (a, b) =>
  a.toLowerCase() < b.toLowerCase()
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));

/** Sorted leaves, then one level at a time. Returns every level bottom up. */
export function build(leaves) {
  const sorted = [...leaves].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const levels = [sorted];
  let level = sorted;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
    level = next;
  }
  return { root: level[0], levels };
}

/** Siblings from the leaf up. An odd node that was promoted contributes none. */
export function proofFor(levels, leaf) {
  const proof = [];
  let index = levels[0].findIndex((h) => h.toLowerCase() === leaf.toLowerCase());
  if (index < 0) throw new Error(`${leaf} is not a leaf of this tree`);
  for (let d = 0; d < levels.length - 1; d++) {
    const level = levels[d];
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    if (sibling < level.length) proof.push(level[sibling]);
    index = Math.floor(index / 2);
  }
  return proof;
}

/** Same walk the contract does, so a proof is checked before it is spent. */
export function verify(leaf, proof, root) {
  let node = leaf;
  for (const sibling of proof) node = pair(node, sibling);
  return node.toLowerCase() === root.toLowerCase();
}

export function panelRecords() {
  return PANELS.map((p) => {
    const jurors = p.jurors.map(leafOf);
    const { root, levels } = build(jurors.map((j) => j.hash));
    const claimHash = keccak256(toHex(p.claim));
    const caseId = keccak256(encodePacked(["bytes32", "bytes32"], [claimHash, root]));
    return {
      ...p,
      claimHash,
      caseId,
      panelRoot: root,
      panelSize: jurors.length,
      jurors: jurors.map((j) => ({
        ...j,
        proof: proofFor(levels, j.hash),
        verifies: verify(j.hash, proofFor(levels, j.hash), root),
      })),
    };
  });
}

/** A real signal that sat on no panel, for the negative check. */
export function nonMember() {
  const onPanel = new Set(PANELS.flatMap((p) => p.jurors).map((f) => leafOf(f).hash));
  for (const file of readdirSync(FIXTURES)) {
    const leaf = leafOf(file);
    if (!onPanel.has(leaf.hash)) return leaf;
  }
  return null;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const records = panelRecords();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(records, null, 2));
  } else {
    for (const r of records) {
      console.log(`panel ${r.name}`);
      console.log(`  claim       ${r.claim}`);
      console.log(`  claimHash   ${r.claimHash}`);
      console.log(`  caseId      ${r.caseId}`);
      console.log(`  panelRoot   ${r.panelRoot}`);
      console.log(`  verdict     ${r.verdict}  confidenceBp ${r.confidenceBp}  panelSize ${r.panelSize}`);
      for (const j of r.jurors) {
        console.log(`  juror ${j.miner}`);
        console.log(`    signalHash ${j.hash}  rederived from ${j.file}`);
        console.log(`    proof      [${j.proof.join(", ")}]  verifies=${j.verifies}`);
      }
    }
  }
}
