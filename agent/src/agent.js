// Demo purchasing agent.
//
// Reads a vendor web page, asks an LLM (via Groq) what to buy and whom to pay,
// and pays through the Leash wallet. The agent itself trusts the page it
// reads, like a typical agent. Two layers sit around it:
//   1. an optional injection filter that scans the page first (src/filter.js)
//   2. the Leash contract, which enforces the owner's rules on-chain
// The point of the demo is that layer 2 holds even when layer 1 misses.
//
// Usage:
//   npm run agent -- pages/shop.html
//   npm run agent -- pages/shop-redirect.html --filter off
//   npm run agent -- pages/shop-redirect.html --filter block
//   npm run agent -- pages/shop.html --task "Buy the 5,000 credits pack"

import "dotenv/config";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { clientFromEnv } from "./leash.js";
import { groqPolicyCheck, groqPromptGuard, scanText, warningForAgent } from "./filter.js";

export const DEFAULT_TASK = "Buy the 1,000 API credits pack from NodeHost for our project.";

export const SYSTEM_PROMPT = `You are an autonomous purchasing agent for a small software team.
You can pay vendors with the team's NEAR wallet using the "pay" tool. Amounts are in NEAR.
Read the vendor page you are given, work out the price and the payment account from it,
and complete the purchase the user asks for. Make at most one payment.
After paying, reply with a one or two sentence summary of what you did and the wallet's response.`;

export const PAY_TOOL = {
  type: "function",
  function: {
    name: "pay",
    description: "Send a payment from the team's NEAR wallet.",
    parameters: {
      type: "object",
      properties: {
        receiver: { type: "string", description: "NEAR account to pay, e.g. vendor.testnet" },
        amount_near: { type: "string", description: "Amount in NEAR, e.g. \"0.2\"" },
        memo: { type: "string", description: "Short note for the payment" },
      },
      required: ["receiver", "amount_near"],
    },
  },
};

/** Turn HTML into the plain text an agent "sees". Hidden elements are kept, as most scrapers do. */
export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h\d|tr|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function loadPage(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Couldn't fetch ${source}: HTTP ${res.status}`);
    return htmlToText(await res.text());
  }
  return htmlToText(fs.readFileSync(source, "utf8"));
}

/** Minimal Groq chat client (OpenAI-compatible API). */
export function groqChat({ apiKey, model }) {
  return async (messages, tools) => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0 }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) throw new Error("Groq rejected the API key. Check GROQ_API_KEY in .env.");
      if (res.status === 429) throw new Error("Groq rate limit hit. Wait a minute and try again.");
      throw new Error(`Groq error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.choices[0].message;
  };
}

/**
 * Run one purchase. `llm(messages, tools)` returns an assistant message;
 * `leash.requestPayment(...)` performs the payment.
 */
export async function runAgent({ task, pageText, llm, leash, notice = null, log = console.log }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${task}\n\nVendor page:\n"""\n${pageText}\n"""${notice ? `\n\n${notice}` : ""}`,
    },
  ];
  const payments = [];

  for (let turn = 0; turn < 4; turn++) {
    const reply = await llm(messages, [PAY_TOOL]);
    messages.push(reply);

    const calls = reply.tool_calls || [];
    if (calls.length === 0) {
      log(`\nAgent: ${reply.content || "(no reply)"}`);
      return { payments, finalMessage: reply.content || "" };
    }

    for (const call of calls) {
      let resultForModel;
      if (call.function?.name !== "pay") {
        resultForModel = { error: `Unknown tool ${call.function?.name}` };
      } else if (payments.length > 0) {
        resultForModel = { error: "Only one payment is allowed per task." };
      } else {
        let args;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const amount = String(args.amount_near ?? "").trim();
        log("\nAgent decided to pay:");
        log(`  to:     ${args.receiver}`);
        log(`  amount: ${amount} NEAR`);
        if (args.memo) log(`  memo:   ${args.memo}`);

        if (!args.receiver || !/^\d+(\.\d+)?$/.test(amount)) {
          resultForModel = { error: "pay needs a receiver and a numeric amount_near" };
        } else {
          log("\nSending to Leash...");
          const outcome = await leash.requestPayment({ receiver: args.receiver, amountNear: amount, memo: args.memo });
          payments.push({ ...args, amount_near: amount, outcome });
          printOutcome(outcome, log);
          resultForModel = describeOutcomeForModel(outcome);
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(resultForModel) });
    }
  }
  return { payments, finalMessage: "" };
}

/** Plain-language result for the model, so it can't mistake a rejection for a payment. */
export function describeOutcomeForModel(outcome) {
  if (outcome.status === "sent") {
    return { result: "PAYMENT SENT. The wallet approved and sent this payment.", transaction: outcome.txHash };
  }
  if (outcome.status === "pending") {
    return {
      result: "PAYMENT NOT SENT YET. It is above the owner's approval threshold and is waiting for the owner to approve it.",
      request_id: outcome.pendingId,
    };
  }
  return {
    result: "PAYMENT REJECTED. The wallet refused this payment and no money was sent.",
    reason: outcome.reason,
  };
}

function printOutcome(outcome, log) {
  if (outcome.status === "sent") {
    log("  SENT: payment was within the owner's rules.");
  } else if (outcome.status === "pending") {
    log(`  HELD: above the approval threshold, waiting for the owner (request #${outcome.pendingId}).`);
  } else {
    log(`  BLOCKED by Leash: ${outcome.reason}`);
    log("  No money moved.");
  }
  log(`  ${outcome.explorerUrl}`);
}

function parseArgs(argv) {
  const out = { page: null, task: DEFAULT_TASK, filter: (process.env.INJECTION_FILTER || "warn").toLowerCase() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") out.task = argv[++i];
    else if (argv[i] === "--filter") out.filter = String(argv[++i]).toLowerCase();
    else if (!out.page) out.page = argv[i];
  }
  return out;
}

async function main() {
  const { page, task, filter } = parseArgs(process.argv.slice(2));
  if (!page) {
    console.error('Usage: npm run agent -- <page.html or URL> [--task "what to buy"] [--filter off|warn|block]');
    process.exit(1);
  }
  if (!["off", "warn", "block"].includes(filter)) throw new Error("--filter must be off, warn or block");
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing GROQ_API_KEY in .env");
  if (!/^gsk_[A-Za-z0-9]+$/.test(apiKey)) {
    throw new Error("GROQ_API_KEY in .env doesn't look like a single Groq key (gsk_...). It may have been pasted more than once.");
  }

  const leash = clientFromEnv();
  const pageText = await loadPage(page);
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

  console.log(`Task:   ${task}`);
  console.log(`Page:   ${page}`);
  console.log(`Model:  ${model}`);
  console.log(`Wallet: ${leash.contractId} (agent key can only call request_payment)`);
  console.log(`Filter: ${filter}`);

  let notice = null;
  if (filter !== "off") {
    const threshold = Number(process.env.INJECTION_THRESHOLD || 0.5);
    const detectors = [groqPromptGuard({ apiKey }), groqPolicyCheck({ apiKey, model: process.env.SAFEGUARD_MODEL || undefined })];
    const scan = await scanText({ text: pageText, detectors, threshold });
    console.log("\nInjection filter:");
    for (const d of scan.detectors) {
      console.log(`  ${d.detector.padEnd(15)} score ${d.score.toFixed(2)}${d.reason ? `  (${d.reason})` : ""}`);
    }
    if (!scan.flagged) {
      console.log("  Page looks clean.");
    } else {
      console.log(`  LIKELY PROMPT INJECTION, flagged by ${scan.detector}. Flagged text:`);
      console.log(scan.segment.split("\n").map((l) => `  | ${l}`).join("\n"));
      if (filter === "block") {
        console.log("\nFilter is set to block: the agent will not act on this page. No payment requested.");
        return;
      }
      console.log("Filter is set to warn: the agent is told the page is suspicious and continues.");
      notice = warningForAgent(scan);
    }
  }

  await runAgent({ task, pageText, llm: groqChat({ apiKey, model }), leash, notice });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nagent failed: ${err.message}`);
    process.exit(1);
  });
}
