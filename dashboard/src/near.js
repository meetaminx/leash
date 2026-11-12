// Reading from NEAR (RPC) and converting amounts. No wallet needed here.

const YOCTO_DIGITS = 24;

/** "1.5" -> "1500000000000000000000000". Throws on anything that isn't a plain positive decimal. */
export function nearToYocto(input) {
  const text = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`"${input}" is not an amount of NEAR`);
  const [whole, frac = ""] = text.split(".");
  if (frac.length > YOCTO_DIGITS) throw new Error("Too many decimal places");
  const yocto = BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(YOCTO_DIGITS, "0") || "0");
  return yocto.toString();
}

/** "1500000000000000000000000" -> "1.5" (up to `decimals` places, trailing zeros removed). */
export function yoctoToNear(yocto, decimals = 4) {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const frac = (value % 10n ** 24n).toString().padStart(YOCTO_DIGITS, "0").slice(0, decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Share of `part` in `whole`, as a percentage clamped to 0..100. */
export function percent(part, whole) {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  const p = (BigInt(part) * 10000n) / w;
  return Math.max(0, Math.min(100, Number(p) / 100));
}

/** Pull "WARDLY: ..." or "FACTORY: ..." out of an error or failed outcome. */
export function contractError(errOrOutcome) {
  const text = typeof errOrOutcome === "string" ? errOrOutcome : JSON.stringify(errOrOutcome ?? "") + String(errOrOutcome?.message ?? "");
  const match = text.match(/(WARDLY|FACTORY): [^"\\]+/);
  return match ? match[0] : null;
}

/** True if a FinalExecutionOutcome (or anything inside it) failed. */
export function outcomeFailed(outcome) {
  if (!outcome || typeof outcome !== "object") return false;
  const statuses = [outcome.status, ...(outcome.receipts_outcome || []).map((r) => r.outcome?.status)];
  return statuses.some((s) => s && typeof s === "object" && "Failure" in s);
}

export function createRpc(url) {
  let id = 0;
  async function call(method, params) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: String(++id), method, params }),
    });
    if (!res.ok) throw new Error(`NEAR RPC returned HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) {
      const cause = data.error.cause?.name || data.error.name || "";
      const message = data.error.data || data.error.message || "RPC error";
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      err.cause = cause;
      throw err;
    }
    return data.result;
  }

  return {
    async view(contractId, method, args = {}) {
      const argsBase64 = btoa(JSON.stringify(args));
      const result = await call("query", {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: argsBase64,
      });
      if (result.error) throw new Error(result.error);
      const text = new TextDecoder().decode(new Uint8Array(result.result));
      return text ? JSON.parse(text) : null;
    },
    async account(accountId) {
      return call("query", { request_type: "view_account", finality: "final", account_id: accountId });
    },
  };
}
