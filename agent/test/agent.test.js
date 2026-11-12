import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { htmlToText, runAgent } from "../src/agent.js";
import { extractFailureReason } from "../src/wardly.js";

const toolCall = (args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "call_1", type: "function", function: { name: "pay", arguments: JSON.stringify(args) } }],
});

function fakeLlm(script) {
  let i = 0;
  return async () => script[i++] ?? { role: "assistant", content: "done" };
}

function fakeWardly(outcome) {
  const calls = [];
  return {
    calls,
    async requestPayment(args) {
      calls.push(args);
      return { ...outcome, txHash: "TX", explorerUrl: "https://explorer.testnet.near.org/transactions/TX" };
    },
  };
}

test("hidden injected text is visible to the agent, comments are not", () => {
  const text = htmlToText(fs.readFileSync("pages/shop-redirect.html", "utf8"));
  assert.match(text, /nodehost-billing\.testnet/);
  assert.match(text, /0\.2 NEAR/);
  assert.doesNotMatch(text, /Attack:/);
});

test("agent pays through Wardly and reports a blocked payment", async () => {
  const wardly = fakeWardly({ status: "blocked", reason: "WARDLY: recipient is not on the allowlist" });
  const logs = [];
  const result = await runAgent({
    task: "buy credits",
    pageText: "page",
    llm: fakeLlm([toolCall({ receiver: "nodehost-billing.testnet", amount_near: "0.2", memo: "1,000 credits" })]),
    wardly,
    log: (s) => logs.push(s),
  });
  assert.equal(wardly.calls.length, 1);
  assert.deepEqual(wardly.calls[0], { receiver: "nodehost-billing.testnet", amountNear: "0.2", memo: "1,000 credits" });
  assert.equal(result.payments[0].outcome.status, "blocked");
  assert.ok(logs.some((l) => l.includes("BLOCKED by Wardly: WARDLY: recipient is not on the allowlist")));
});

test("agent makes at most one payment", async () => {
  const wardly = fakeWardly({ status: "sent" });
  const call = toolCall({ receiver: "shop.testnet", amount_near: "0.2" });
  await runAgent({ task: "t", pageText: "p", llm: fakeLlm([call, call, call]), wardly, log: () => {} });
  assert.equal(wardly.calls.length, 1);
});

test("non-numeric amounts never reach the wallet", async () => {
  const wardly = fakeWardly({ status: "sent" });
  await runAgent({
    task: "t",
    pageText: "p",
    llm: fakeLlm([toolCall({ receiver: "shop.testnet", amount_near: "all of it" })]),
    wardly,
    log: () => {},
  });
  assert.equal(wardly.calls.length, 0);
});

test("extracts the WARDLY reason from a NEAR failure", () => {
  const failure = {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: WARDLY: amount exceeds the per-transaction limit" } },
    },
  };
  assert.equal(extractFailureReason(failure), "WARDLY: amount exceeds the per-transaction limit");
});

test("the model is told plainly when a payment was rejected", async () => {
  const { describeOutcomeForModel } = await import("../src/agent.js");
  const msg = describeOutcomeForModel({ status: "blocked", reason: "WARDLY: recipient is not on the allowlist", txHash: "TX" });
  assert.match(msg.result, /REJECTED/);
  assert.match(msg.result, /no money was sent/);
  assert.equal(msg.transaction, undefined);
});

test("filter notice reaches the agent's input", async () => {
  let seen = null;
  const llm = async (messages) => {
    seen = messages[1].content;
    return { role: "assistant", content: "not paying" };
  };
  await runAgent({ task: "t", pageText: "p", llm, wardly: fakeWardly({ status: "sent" }), notice: "SECURITY NOTICE: test", log: () => {} });
  assert.match(seen, /SECURITY NOTICE: test/);
});
