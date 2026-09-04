// SPDX-License-Identifier: LicenseRef-zkasuran-SAND-1.0
//
// The recorder writes what the jury found onto Base Sepolia, and opens an appeal
// when people disagree with the machines.
//
// Two kinds of write, and they are deliberately different in cost. Committing a
// verdict is gas only, a few millionths of an ETH, so every closed case gets one.
// An appeal spends 1.00 USDC of on-chain escrow to open a real ERC-8183 job, a
// hundred times the price of an ask, so it happens only when a person asks for it.
//
// Sends are serialised through one queue because they all come from one key.

import { createWalletClient, createPublicClient, http, keccak256, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = "https://sepolia.base.org";

const COURT_ABI = parseAbi([
  "function enterVerdict(bytes32 caseId, bytes32 claimHash, uint8 verdict, uint16 confidenceBp, uint16 panelSize, bytes32 panelRoot)",
  "function registerAppeal(bytes32 caseId, uint256 jobId)",
]);
const DIAMOND_ABI = parseAbi([
  "function createJob(bytes32 intentId, (address[],uint256[],string[],bool[]) params, address callback) returns (uint256)",
  "function escrowBalance(address) view returns (uint256)",
  "function jobCount() view returns (uint256)",
]);

// 0 unknown, 1 the panel corroborated an answer, 2 refuted, 3 hung.
// A 1 does not mean "this claim is true in the world". It means a jury of
// independent miners agreed on the same answer and we could verify every vote.
const VERDICT = { corroborated: 1, refuted: 2, hung: 3, thin: 0, single_source: 0, no_quorum: 0 };

let queue = Promise.resolve();
const serialise = (fn) => {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

function clients(env) {
  const account = privateKeyToAccount(env.PAYER_KEY);
  const transport = http(RPC);
  return {
    account,
    wallet: createWalletClient({ account, chain: baseSepolia, transport }),
    pub: createPublicClient({ chain: baseSepolia, transport }),
  };
}

const bytes32 = (s) => keccak256(new TextEncoder().encode(s));

/** Commit a closed case. Gas only, so every case gets one. */
export async function commitVerdict(env, kase, court) {
  const t = kase.tally || {};
  const verdict = VERDICT[t.outcome] ?? 0;
  if (!kase.panelRoot || !t.counted) return { skipped: "nothing to commit, no counted votes" };
  return serialise(async () => {
    const { wallet, pub } = clients(env);
    const data = encodeFunctionData({
      abi: COURT_ABI,
      functionName: "enterVerdict",
      args: [bytes32(kase.id), kase.claimHash, verdict, Math.min(10000, t.agreementBps || 0), Math.min(65535, t.counted), kase.panelRoot],
    });
    const hash = await wallet.sendTransaction({ to: court, data });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return { verdictTx: hash, block: Number(receipt.blockNumber), status: receipt.status, verdict, confidenceBp: t.agreementBps };
  });
}

/**
 * Open an appeal. The same question goes back to the network through a different
 * rail, a different payment currency and a different miner set, so the answer
 * cross-checks the off-chain panel rather than restating it.
 */
export async function openAppeal(env, kase, court, intentName) {
  return serialise(async () => {
    const { wallet, pub, account } = clients(env);
    const diamond = env.DIAMOND;
    const escrow = await pub.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: "escrowBalance", args: [account.address] });
    if (escrow < 1_000_000n) return { skipped: `escrow holds $${(Number(escrow) / 1e6).toFixed(2)}, and an appeal costs $1.00` };

    const intentId = bytes32(intentName);
    const params = [[], [], [kase.claim], []];
    const before = await pub.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: "jobCount" });
    const createData = encodeFunctionData({ abi: DIAMOND_ABI, functionName: "createJob", args: [intentId, params, court] });
    const createTx = await wallet.sendTransaction({ to: diamond, data: createData });
    const receipt = await pub.waitForTransactionReceipt({ hash: createTx, timeout: 90_000 });
    if (receipt.status !== "success") return { error: "createJob reverted", createTx };

    // Job ids are sequential, so the one we just opened is the previous count.
    const jobId = Number(before);
    const regData = encodeFunctionData({ abi: COURT_ABI, functionName: "registerAppeal", args: [bytes32(kase.id), BigInt(jobId)] });
    const registerTx = await wallet.sendTransaction({ to: court, data: regData });
    await pub.waitForTransactionReceipt({ hash: registerTx, timeout: 60_000 });
    return { jobId, createTx, registerTx, intent: intentName, openedAt: Math.floor(Date.now() / 1000) };
  });
}

/** Intents where we operate no miner, so an appeal's 0.98 USDC always leaves our control. */
export function appealAllowed(catalogue, intent, ourWallet) {
  const mine = catalogue.filter(
    (m) => (m.supported_intents || []).includes(intent) && String(m.wallet_address || "").toLowerCase() === ourWallet
  );
  return mine.length === 0;
}

export { VERDICT };
