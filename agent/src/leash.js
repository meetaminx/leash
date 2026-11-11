// Thin client for the Leash wallet contract.
//
// The agent signs with a function-call access key that NEAR itself limits to
// calling `request_payment` on the Leash contract. Every rule (allowlist,
// per-payment cap, daily limit, approval threshold) is enforced on-chain.

import { Account, JsonRpcProvider, actions, nearToYocto, yoctoToNear, teraToGas } from "near-api-js";

export function explorerTxUrl(network, txHash) {
  const host = network === "mainnet" ? "explorer.near.org" : "explorer.testnet.near.org";
  return `https://${host}/transactions/${txHash}`;
}

/** Pull the human-readable reason out of a failed transaction. */
export function extractFailureReason(failure) {
  const text = JSON.stringify(failure);
  const leash = text.match(/LEASH: [^"\\]+/);
  if (leash) return leash[0];
  const panic = text.match(/"ExecutionError":"([^"]+)"/);
  if (panic) return panic[1];
  return text.slice(0, 300);
}

function decodeSuccessValue(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export class LeashClient {
  constructor({ rpcUrl, network, contractId, agentAccountId, agentPrivateKey }) {
    this.network = network;
    this.contractId = contractId;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.agentAccountId = agentAccountId;
    this.account = agentPrivateKey
      ? new Account(agentAccountId, this.provider, agentPrivateKey)
      : null;
  }

  async view(method, args = {}) {
    return this.provider.callFunction({ contractId: this.contractId, method, args });
  }

  getConfig() {
    return this.view("get_config");
  }

  getRemainingToday() {
    return this.view("get_remaining_today");
  }

  getAllowlist() {
    return this.view("get_allowlist");
  }

  getPending() {
    return this.view("get_pending");
  }

  /**
   * Ask Leash to pay. Never throws for a contract rejection: returns
   * { status: "sent" | "pending" | "blocked", reason?, txHash, explorerUrl }.
   */
  async requestPayment({ receiver, amountNear, memo }) {
    if (!this.account) throw new Error("AGENT_PRIVATE_KEY is not set. Run `npm run setup-key` first.");
    const amount = nearToYocto(String(amountNear)).toString();
    const args = { receiver, amount, memo: memo ? String(memo).slice(0, 256) : null };

    const result = await this.account.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall("request_payment", args, teraToGas("50"), 0n)],
      throwOnFailure: false,
    });

    const txHash = result.transaction_outcome.id;
    const explorerUrl = explorerTxUrl(this.network, txHash);
    const status = result.status;

    if (status && typeof status === "object" && "Failure" in status) {
      return { status: "blocked", reason: extractFailureReason(status.Failure), txHash, explorerUrl };
    }

    const outcome = decodeSuccessValue(status?.SuccessValue);
    if (outcome && typeof outcome === "object" && "PendingApproval" in outcome) {
      return { status: "pending", pendingId: outcome.PendingApproval.id, txHash, explorerUrl };
    }
    return { status: "sent", txHash, explorerUrl };
  }
}

export function clientFromEnv(env = process.env) {
  const required = ["NEAR_RPC_URL", "LEASH_CONTRACT", "AGENT_ACCOUNT"];
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing ${key} in .env (see .env.example)`);
  }
  return new LeashClient({
    rpcUrl: env.NEAR_RPC_URL,
    network: env.NEAR_NETWORK || "testnet",
    contractId: env.LEASH_CONTRACT,
    agentAccountId: env.AGENT_ACCOUNT,
    agentPrivateKey: env.AGENT_PRIVATE_KEY || null,
  });
}

export { yoctoToNear };
