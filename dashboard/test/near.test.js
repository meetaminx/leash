import test from "node:test";
import assert from "node:assert/strict";
import { contractError, nearToYocto, outcomeFailed, percent, yoctoToNear } from "../src/near.js";

test("converts NEAR to yoctoNEAR", () => {
  assert.equal(nearToYocto("1"), "1000000000000000000000000");
  assert.equal(nearToYocto("0.5"), "500000000000000000000000");
  assert.equal(nearToYocto("2.25"), "2250000000000000000000000");
  assert.throws(() => nearToYocto("-1"));
  assert.throws(() => nearToYocto("abc"));
  assert.throws(() => nearToYocto(""));
});

test("converts yoctoNEAR to NEAR", () => {
  assert.equal(yoctoToNear("1000000000000000000000000"), "1");
  assert.equal(yoctoToNear("500000000000000000000000"), "0.5");
  assert.equal(yoctoToNear("9098612345678901234567890"), "9.0986");
  assert.equal(yoctoToNear("0"), "0");
});

test("percent is clamped", () => {
  assert.equal(percent("1", "2"), 50);
  assert.equal(percent("3", "2"), 100);
  assert.equal(percent("1", "0"), 0);
});

test("finds contract error messages", () => {
  assert.equal(contractError({ x: "Smart contract panicked: LEASH: only the owner can do this" }), "LEASH: only the owner can do this");
  assert.equal(contractError(new Error("FACTORY: name must be 2 to 32 characters")), "FACTORY: name must be 2 to 32 characters");
  assert.equal(contractError("nothing here"), null);
});

test("detects failed outcomes", () => {
  assert.equal(outcomeFailed({ status: { SuccessValue: "" }, receipts_outcome: [] }), false);
  assert.equal(outcomeFailed({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: {} } } }] }), true);
});
