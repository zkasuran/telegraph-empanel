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

import { createWalletClient, createPublicClient, http, fallback, keccak256, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// One public endpoint rate limits from Worker addresses often enough to lose a
// verdict, so read and write across several and let viem fall through.
const RPCS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.gateway.tenderly.co",
];

// Base Sepolia sits near 0.006 gwei. Setting the fees explicitly keeps the send to
// one round trip instead of three, which is the difference between a verdict landing
// and a fee estimation failing on a rate limited endpoint.
const FEES = { maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 2_000_000n };

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
  const transport = fallback(
    RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 400, timeout: 20_000 })),
    { rank: false }
  );
  return {
    account,
    wallet: createWalletClient({ account, chain: baseSepolia, transport }),
    pub: createPublicClient({ chain: baseSepolia, transport }),
  };
}

/** Send with the fees pinned and the nonce read fresh, then wait for the receipt. */
async function send(wallet, pub, account, to, data, gas) {
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const hash = await wallet.sendTransaction({ to, data, nonce, gas, ...FEES });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  return { hash, receipt };
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
    const { wallet: w, pub: p, account } = { wallet, pub, account: clients(env).account };
    const { hash, receipt } = await send(w, p, account, court, data, 200_000n);
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
    const { hash: createTx, receipt } = await send(wallet, pub, account, diamond, createData, 500_000n);
    if (receipt.status !== "success") return { error: "createJob reverted", createTx };

    // Job ids are sequential, so the one we just opened is the previous count.
    const jobId = Number(before);
    const regData = encodeFunctionData({ abi: COURT_ABI, functionName: "registerAppeal", args: [bytes32(kase.id), BigInt(jobId)] });
    const { hash: registerTx } = await send(wallet, pub, account, court, regData, 150_000n);
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
