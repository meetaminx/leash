// Prints the Wardly wallet's current rules and state.

import "dotenv/config";
import { clientFromEnv, yoctoToNear } from "./wardly.js";

const near = (yocto) => `${yoctoToNear(BigInt(yocto), 4)} NEAR`;

async function main() {
  const wardly = clientFromEnv();
  const [config, remaining, allowlist, pending, balance] = await Promise.all([
    wardly.getConfig(),
    wardly.getRemainingToday(),
    wardly.getAllowlist(),
    wardly.getPending(),
    wardly.provider.viewAccount({ accountId: wardly.contractId }).then((a) => a.amount).catch(() => null),
  ]);

  console.log(`Wardly wallet: ${wardly.contractId}`);
  if (balance) console.log(`  balance:              ${near(balance)}`);
  console.log(`  owner:                ${config.owner}`);
  console.log(`  agent:                ${config.agent}`);
  console.log(`  paused:               ${config.paused}`);
  console.log(`  max per payment:      ${near(config.max_per_tx)}`);
  console.log(`  daily limit:          ${near(config.daily_limit)}`);
  console.log(`  approval needed over: ${near(config.approval_threshold)}`);
  console.log(`  left to spend today:  ${near(remaining)}`);
  console.log(`  approved recipients:  ${allowlist.length ? allowlist.join(", ") : "(none)"}`);
  console.log(`  waiting for approval: ${pending.length}`);
  for (const p of pending) {
    console.log(`    #${p.id}  ${near(p.amount)} to ${p.receiver}${p.memo ? `  "${p.memo}"` : ""}`);
  }
}

main().catch((err) => {
  console.error(`status failed: ${err.message}`);
  process.exit(1);
});
