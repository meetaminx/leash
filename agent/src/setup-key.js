// Creates the agent's restricted key.
//
// Generates a new key pair, then uses the agent account's full access key
// (from the NEAR CLI keychain on this machine) to add it as a function-call
// access key that can only call `request_payment` on the Wardly contract.
// The new private key is written to .env. The agent never sees the full
// access key.

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from "near-api-js";
import { explorerTxUrl } from "./wardly.js";

const ENV_PATH = path.resolve(".env");
const force = process.argv.includes("--force");

function setEnvValue(file, key, value) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fs.readFileSync(".env.example", "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
}

async function main() {
  const network = process.env.NEAR_NETWORK || "testnet";
  const rpcUrl = process.env.NEAR_RPC_URL;
  const contractId = process.env.WARDLY_CONTRACT;
  const agentId = process.env.AGENT_ACCOUNT;
  if (!rpcUrl || !contractId || !agentId) {
    throw new Error("Fill in NEAR_RPC_URL, WARDLY_CONTRACT and AGENT_ACCOUNT in .env first (copy .env.example to .env).");
  }
  if (process.env.AGENT_PRIVATE_KEY && !force) {
    throw new Error("AGENT_PRIVATE_KEY is already set in .env. Run `npm run setup-key -- --force` to replace it.");
  }

  const credFile = path.join(os.homedir(), ".near-credentials", network, `${agentId}.json`);
  if (!fs.existsSync(credFile)) {
    throw new Error(`Couldn't find ${credFile}. It is created when you make the account with save-to-legacy-keychain.`);
  }
  const fullAccess = JSON.parse(fs.readFileSync(credFile, "utf8"));

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const owner = new Account(agentId, provider, fullAccess.private_key);

  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();

  console.log(`Adding a restricted key to ${agentId}`);
  console.log(`  can call:   ${contractId} -> request_payment (nothing else)`);
  console.log(`  gas budget: 0.25 NEAR`);
  console.log(`  public key: ${publicKey}\n`);

  const result = await owner.addFunctionCallAccessKey({
    publicKey,
    contractId,
    methodNames: ["request_payment"],
    allowance: nearToYocto("0.25"),
  });

  setEnvValue(ENV_PATH, "AGENT_PRIVATE_KEY", keyPair.toString());

  console.log("Done. The restricted key's private part is saved in .env as AGENT_PRIVATE_KEY.");
  console.log(`Transaction: ${explorerTxUrl(network, result.transaction_outcome.id)}`);
}

main().catch((err) => {
  console.error(`\nsetup-key failed: ${err.message}`);
  process.exit(1);
});
