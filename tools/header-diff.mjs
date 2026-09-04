// Diff our hand-rolled x402 header against the SDK's, byte for byte.
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";

const env = fs.readFileSync("/home/asuran/Downloads/hackathon-hq/work/telegraph/.wallet.env", "utf8");
const account = privateKeyToAccount((env.match(/0x[0-9a-fA-F]{64}/) || [])[0]);

const real = globalThis.fetch;
let captured = null;
globalThis.fetch = async (...args) => {
  try {
    const req = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
    const h = req.headers.get("payment-signature");
    if (h) captured = h;
  } catch {}
  return real(...args);
};

const client = x402Client.fromConfig({
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(toClientEvmSigner(account)) }],
});
const payFetch = wrapFetchWithPayment(globalThis.fetch, client);
const res = await payFetch("https://devnode.telegraphprotocol.com/engine/v1/ask/9002", {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "curl/8.5.0" },
  body: JSON.stringify({ method: "GET", endpoint: "/gas-price", payload: { chain: "base" }, acknowledge_warnings: true }),
});
console.log("sdk call status", res.status);
console.log(captured ? JSON.stringify(JSON.parse(Buffer.from(captured, "base64").toString()), null, 1) : "no header captured");
