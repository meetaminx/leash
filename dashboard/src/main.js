import { NearConnector } from "@hot-labs/near-connect";
import { contractError, createRpc, nearToYocto, outcomeFailed, percent, yoctoToNear } from "./near.js";

const cfg = {
  network: import.meta.env.VITE_NETWORK || "testnet",
  rpcUrl: import.meta.env.VITE_RPC_URL || "https://test.rpc.fastnear.com",
  factoryId: import.meta.env.VITE_FACTORY_ID || "meetaminx-factory.testnet",
  explorer: import.meta.env.VITE_EXPLORER_URL || "https://explorer.testnet.near.org",
};

const rpc = createRpc(cfg.rpcUrl);
const STORAGE_COST_PER_BYTE = 10n ** 19n;
const TGAS = 10n ** 12n;

const state = {
  account: null,
  wallet: null,
  myLeashes: [],
  opened: loadOpened(),
  selected: new URLSearchParams(location.search).get("wallet"),
  view: null, // "create" | "wallet" | null
  data: null,
  loadError: null,
  minDeposit: null,
  busy: false,
};
if (state.selected) state.view = "wallet";
else if (new URLSearchParams(location.search).has("create")) state.view = "create";

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const near = (yocto) => `${yoctoToNear(yocto)} NEAR`;

// ---------------------------------------------------------------------------
// Browser storage: only remembers wallets you opened by hand on this device.
// ---------------------------------------------------------------------------

function loadOpened() {
  try {
    return JSON.parse(localStorage.getItem("leash.opened") || "[]");
  } catch {
    return [];
  }
}
function saveOpened() {
  try {
    localStorage.setItem("leash.opened", JSON.stringify(state.opened));
  } catch {
    /* storage unavailable: the list just won't persist */
  }
}

// ---------------------------------------------------------------------------
// Wallet connection
// ---------------------------------------------------------------------------

const connector = new NearConnector({
  network: cfg.network,
  features: { signAndSendTransaction: true, testnet: cfg.network === "testnet" },
  footerBranding: null,
});

connector.on("wallet:signIn", async (event) => {
  state.account = event.accounts[0]?.accountId ?? null;
  state.wallet = await connector.wallet();
  await loadMyLeashes();
  render();
});

connector.on("wallet:signOut", () => {
  state.account = null;
  state.wallet = null;
  state.myLeashes = [];
  render();
});

async function restoreSession() {
  try {
    const { wallet, accounts } = await connector.getConnectedWallet();
    state.wallet = wallet;
    state.account = accounts[0]?.accountId ?? null;
    await loadMyLeashes();
  } catch {
    /* not connected yet */
  }
}

async function connect() {
  try {
    await connector.connect();
  } catch (err) {
    showNotice(`Couldn't connect a wallet: ${err.message || err}`, true);
  }
}

async function disconnect() {
  try {
    await connector.disconnect();
  } catch {
    /* already disconnected */
  }
  state.account = null;
  state.wallet = null;
  state.myLeashes = [];
  render();
}

/** Sign and send one function call. Throws with the contract's own message if it fails. */
async function call(receiverId, methodName, args, { deposit = "0", tgas = 50 } = {}) {
  if (!state.wallet) throw new Error("Connect a wallet first.");
  const outcome = await state.wallet.signAndSendTransaction({
    receiverId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName, args, gas: (BigInt(tgas) * TGAS).toString(), deposit },
      },
    ],
  });
  if (outcomeFailed(outcome)) {
    throw new Error(contractError(outcome) || "The transaction failed on-chain.");
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadMyLeashes() {
  if (!state.account) return;
  try {
    state.myLeashes = (await rpc.view(cfg.factoryId, "get_leashes", { owner: state.account })) || [];
  } catch {
    state.myLeashes = [];
  }
}

async function loadMinDeposit() {
  if (state.minDeposit) return;
  try {
    state.minDeposit = await rpc.view(cfg.factoryId, "get_min_deposit");
  } catch {
    state.minDeposit = null;
  }
}

async function loadWallet(id) {
  state.data = null;
  state.loadError = null;
  render();
  try {
    const [config, remaining, allowlist, pending, account] = await Promise.all([
      rpc.view(id, "get_config"),
      rpc.view(id, "get_remaining_today"),
      rpc.view(id, "get_allowlist"),
      rpc.view(id, "get_pending"),
      rpc.account(id),
    ]);
    const locked = BigInt(account.storage_usage) * STORAGE_COST_PER_BYTE;
    const available = BigInt(account.amount) > locked ? BigInt(account.amount) - locked : 0n;
    state.data = { id, config, remaining, allowlist, pending, balance: account.amount, available: available.toString() };
  } catch (err) {
    const msg = String(err.message || err);
    state.loadError = /does not exist|UNKNOWN_ACCOUNT/i.test(msg)
      ? `${id} doesn't exist on ${cfg.network}.`
      : /MethodNotFound|CodeDoesNotExist|wasm execution failed|CompilationError/i.test(msg)
        ? `${id} isn't a Leash wallet.`
        : `Couldn't load ${id}: ${msg}`;
  }
  render();
}

function selectWallet(id) {
  state.selected = id;
  state.view = "wallet";
  const url = new URL(location.href);
  url.searchParams.set("wallet", id);
  history.replaceState(null, "", url);
  loadWallet(id);
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

let noticeTimer;
function showNotice(text, isError = false) {
  const el = $("notice");
  el.textContent = text;
  el.className = isError ? "notice error" : "notice";
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.hidden = true), isError ? 12000 : 6000);
}

async function run(action, successText) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await action();
    if (successText) showNotice(successText);
  } catch (err) {
    showNotice(contractError(err) || err.message || String(err), true);
  } finally {
    state.busy = false;
    if (state.view === "wallet" && state.selected) await loadWallet(state.selected);
    else render();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  $("network").textContent = cfg.network === "testnet" ? "Testnet" : "Mainnet";
  $("session").innerHTML = state.account
    ? `<span class="acct">${esc(state.account)}</span><button class="quiet" data-action="disconnect">Disconnect</button>`
    : `<button class="quiet" data-action="connect">Connect wallet</button>`;
  renderRail();
  if (state.view === "create") renderCreate();
  else if (state.view === "wallet") renderWallet();
  else renderWelcome();
}

function renderRail() {
  const ids = [...new Set([...state.myLeashes, ...state.opened])];
  const list = ids.length
    ? `<ul>${ids
        .map(
          (id) =>
            `<li><button data-action="select" data-id="${esc(id)}" aria-current="${id === state.selected && state.view === "wallet"}">${esc(id)}</button></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">${state.account ? "You don't have a Leash wallet yet." : "Connect a wallet to see the Leash wallets you own."}</p>`;

  $("rail").innerHTML = `
    <h2>Your wallets</h2>
    ${list}
    <div class="actions">
      <button data-action="show-create">Create a wallet</button>
      <form data-form="open">
        <label for="open-id">Open a wallet by account</label>
        <input id="open-id" name="id" placeholder="name.testnet" autocomplete="off" required />
        <button class="quiet" type="submit">Open</button>
      </form>
    </div>`;
}

function renderWelcome() {
  $("main").innerHTML = `
    <div class="welcome">
      <h1>Give your AI agent a wallet with limits</h1>
      <p>A Leash wallet holds the money your agent is allowed to spend. You decide which accounts it can pay, the most it can send in one payment and in one day, and which payments wait for your approval.</p>
      <p>The rules run in a contract on NEAR, so an agent that gets tricked by something it reads still can't break them.</p>
      <ol>
        <li>Connect your NEAR wallet.</li>
        <li>Create a Leash wallet and set its rules.</li>
        <li>Give your agent the wallet's account and a key that can only request payments.</li>
      </ol>
      ${
        state.account
          ? `<button data-action="show-create">Create a wallet</button>`
          : `<button data-action="connect">Connect wallet</button>`
      }
    </div>`;
}

function renderCreate() {
  if (!state.account) {
    $("main").innerHTML = `
      <div class="welcome">
        <h1>Create a Leash wallet</h1>
        <p>Connect the NEAR account that should own the new wallet. Only the owner can change its rules or approve held payments.</p>
        <button data-action="connect">Connect wallet</button>
      </div>`;
    return;
  }
  const min = state.minDeposit ? yoctoToNear(state.minDeposit, 2) : "2";
  $("main").innerHTML = `
    <h1>Create a Leash wallet</h1>
    <p class="muted" style="margin-top:6px">You'll be the owner. You can change everything except the name later.</p>
    <form class="section" data-form="create" novalidate>
      <div class="field">
        <label for="c-name">Wallet name</label>
        <input id="c-name" name="name" required minlength="2" maxlength="32" pattern="[a-z0-9]([a-z0-9_\\-]*[a-z0-9])?" autocomplete="off" placeholder="research-bot" />
        <span class="hint" id="c-name-preview">Lowercase letters, numbers, - and _.</span>
      </div>
      <div class="field">
        <label for="c-agent">Agent account</label>
        <input id="c-agent" name="agent" required autocomplete="off" placeholder="my-agent.testnet" />
        <span class="hint">The account your AI agent signs with. It can only request payments.</span>
      </div>
      <div class="row">
        <div class="field">
          <label for="c-max">Max per payment</label>
          <div class="suffix"><input id="c-max" name="max" inputmode="decimal" value="1" required /><span>NEAR</span></div>
        </div>
        <div class="field">
          <label for="c-daily">Daily limit</label>
          <div class="suffix"><input id="c-daily" name="daily" inputmode="decimal" value="2" required /><span>NEAR</span></div>
        </div>
        <div class="field">
          <label for="c-approve">Ask me above</label>
          <div class="suffix"><input id="c-approve" name="approve" inputmode="decimal" value="0.5" required /><span>NEAR</span></div>
        </div>
      </div>
      <div class="field">
        <label for="c-recipients">Approved recipients</label>
        <textarea id="c-recipients" name="recipients" placeholder="shop.testnet&#10;api-provider.testnet"></textarea>
        <span class="hint">One account per line. The agent can't pay anyone else. You can add more later.</span>
      </div>
      <div class="field">
        <label for="c-deposit">Starting deposit</label>
        <div class="suffix"><input id="c-deposit" name="deposit" inputmode="decimal" value="${esc(Math.max(2.5, Number(min) + 0.5))}" required /><span>NEAR</span></div>
        <span class="hint">At least ${esc(min)} NEAR. About ${esc(min)} NEAR stays in the wallet to pay for its storage; the rest is what the agent can spend.</span>
      </div>
      <button type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "Creating..." : "Create wallet"}</button>
    </form>`;
}

function meter(d) {
  const { config, remaining } = d;
  const daily = config.daily_limit;
  const slack = percent(remaining, daily);
  const approveAt = percent(config.approval_threshold, daily);
  const capAt = percent(config.max_per_tx, daily);
  return `
    <div class="meter" aria-label="Today's allowance">
      <div class="meter-figure">
        <strong class="num">${esc(yoctoToNear(remaining))} NEAR</strong>
        <span class="muted">left for automatic payments today, of ${esc(near(daily))}. Resets at 00:00 UTC.</span>
      </div>
      <div class="track" role="img" aria-label="${esc(`${yoctoToNear(remaining)} of ${yoctoToNear(daily)} NEAR left today`)}">
        <div class="slack" style="width:${slack}%"></div>
        <div class="mark approve" style="left:${approveAt}%"></div>
        ${capAt < 100 ? `<div class="mark cap" style="left:${capAt}%"></div>` : ""}
      </div>
      <ul class="key">
        <li><span class="swatch approve"></span>Payments above ${esc(near(config.approval_threshold))} wait for your approval</li>
        <li><span class="swatch cap"></span>No single payment over ${esc(near(config.max_per_tx))}</li>
      </ul>
    </div>`;
}

function renderWallet() {
  const main = $("main");
  if (state.loadError) {
    main.innerHTML = `<h1>${esc(state.selected)}</h1><p class="section">${esc(state.loadError)}</p>`;
    return;
  }
  const d = state.data;
  if (!d) {
    main.innerHTML = `<h1>${esc(state.selected)}</h1><p class="muted" style="margin-top:10px">Loading wallet...</p>`;
    return;
  }
  const { config } = d;
  const isOwner = state.account === config.owner;
  const dis = !isOwner || state.busy ? "disabled" : "";

  const pending = d.pending.length
    ? `<ul class="list">${d.pending
        .map(
          (p) => `
        <li>
          <div class="what">
            <strong class="num">${esc(near(p.amount))}</strong> to <span class="acct">${esc(p.receiver)}</span>
            ${p.memo ? `<div class="muted">"${esc(p.memo)}"</div>` : ""}
            <div class="muted">Requested ${esc(new Date(Number(BigInt(p.requested_at) / 1000000n)).toLocaleString())}</div>
          </div>
          ${
            isOwner
              ? `<div class="btns">
            <button data-action="approve" data-id="${esc(p.id)}" ${dis}>Approve and send</button>
            <button class="quiet" data-action="reject" data-id="${esc(p.id)}" ${dis}>Reject</button>
          </div>`
              : ""
          }
        </li>`,
        )
        .join("")}</ul>`
    : `<p class="empty-line">Nothing is waiting. Payments above ${esc(near(config.approval_threshold))} will show up here.</p>`;

  const recipients = d.allowlist.length
    ? `<ul class="list">${d.allowlist
        .map(
          (r) => `
        <li>
          <span class="acct">${esc(r)}</span>
          ${isOwner ? `<div class="btns"><button class="quiet" data-action="remove-recipient" data-id="${esc(r)}" ${dis}>Remove</button></div>` : ""}
        </li>`,
        )
        .join("")}</ul>`
    : `<p class="empty-line">No approved recipients. The agent can't pay anyone until you add one.</p>`;

  main.innerHTML = `
    <section class="section" style="margin-top:0">
      <div class="wallet-head">
        <div>
          <h1>${esc(d.id)}<span class="status ${config.paused ? "paused" : "live"}">${config.paused ? "Paused" : "Active"}</span></h1>
          <p class="balance num">${esc(near(d.balance))} in the wallet</p>
          <p class="muted">Owner <span class="acct">${esc(config.owner)}</span>, agent <span class="acct">${esc(config.agent)}</span></p>
        </div>
        ${
          !isOwner
            ? ""
            : config.paused
              ? `<button data-action="unpause" ${dis}>Resume agent</button>`
              : `<button class="danger" data-action="pause" ${dis}>Pause agent</button>`
        }
      </div>
      ${
        isOwner
          ? ""
          : `<p class="readonly">You're viewing this wallet. Only its owner, <span class="acct">${esc(config.owner)}</span>, can change it${state.account ? "" : ". Connect that account to make changes"}.</p>`
      }
      ${meter(d)}
    </section>

    <section class="section">
      <h2>Waiting for your approval</h2>
      <p class="muted">Payments the agent asked for above your approval limit. Nothing is sent until you approve.</p>
      ${pending}
    </section>

    <section class="section">
      <h2>Approved recipients</h2>
      <p class="muted">The only accounts the agent can pay.</p>
      ${recipients}
      ${
        isOwner
          ? `<form class="inline-form" data-form="add-recipient">
        <input name="id" aria-label="Account to approve" placeholder="account.testnet" autocomplete="off" required ${dis} />
        <button type="submit" ${dis}>Add</button>
      </form>`
          : ""
      }
    </section>
    ${isOwner ? ownerSettings(config, d, dis) : ""}

    <p class="muted" style="margin-top:18px"><a href="${esc(`${cfg.explorer}/address/${d.id}`)}" target="_blank" rel="noopener">See this wallet's transactions in the explorer</a></p>`;
}


function ownerSettings(config, d, dis) {
  return `<section class="section">
      <h2>Spending rules</h2>
      <p class="muted">Changes apply to the agent's next request.</p>
      <form data-form="limits">
        <div class="row">
          <div class="field">
            <label for="l-max">Max per payment</label>
            <div class="suffix"><input id="l-max" name="max" inputmode="decimal" value="${esc(yoctoToNear(config.max_per_tx, 24))}" required ${dis} /><span>NEAR</span></div>
          </div>
          <div class="field">
            <label for="l-daily">Daily limit</label>
            <div class="suffix"><input id="l-daily" name="daily" inputmode="decimal" value="${esc(yoctoToNear(config.daily_limit, 24))}" required ${dis} /><span>NEAR</span></div>
          </div>
          <div class="field">
            <label for="l-approve">Ask me above</label>
            <div class="suffix"><input id="l-approve" name="approve" inputmode="decimal" value="${esc(yoctoToNear(config.approval_threshold, 24))}" required ${dis} /><span>NEAR</span></div>
          </div>
        </div>
        <button type="submit" ${dis}>Save rules</button>
      </form>
    </section>

    <section class="section">
      <h2>Agent</h2>
      <p class="muted">If the agent's key leaks, pause the wallet and switch to a new agent account.</p>
      <form class="inline-form" data-form="agent">
        <input name="id" aria-label="New agent account" placeholder="${esc(config.agent)}" autocomplete="off" required ${dis} />
        <button type="submit" ${dis}>Change agent</button>
      </form>
    </section>

    <section class="section">
      <h2>Withdraw</h2>
      <p class="muted">Send funds back to the owner. ${esc(near(d.available))} can be withdrawn; the rest pays for the wallet's storage.</p>
      <form class="inline-form" data-form="withdraw">
        <div class="suffix" style="flex:1"><input name="amount" aria-label="Amount to withdraw" inputmode="decimal" placeholder="0.5" required ${dis} /><span>NEAR</span></div>
        <button type="submit" ${dis}>Withdraw to owner</button>
      </form>
    </section>`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function limitsFromForm(form) {
  const max = nearToYocto(form.max.value);
  const daily = nearToYocto(form.daily.value);
  const approve = nearToYocto(form.approve.value);
  if (BigInt(max) === 0n) throw new Error("Max per payment must be more than 0.");
  if (BigInt(approve) > BigInt(max)) throw new Error("The approval limit can't be above the max per payment.");
  if (BigInt(approve) > BigInt(daily)) throw new Error("The approval limit can't be above the daily limit.");
  return { max_per_tx: max, daily_limit: daily, approval_threshold: approve };
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
function accountId(value, label) {
  const id = String(value).trim().toLowerCase();
  if (id.length < 2 || id.length > 64 || !ACCOUNT_RE.test(id)) throw new Error(`${label} "${value}" isn't a valid NEAR account.`);
  return id;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const { action, id } = btn.dataset;
  const leash = state.selected;
  switch (action) {
    case "connect":
      return connect();
    case "disconnect":
      return disconnect();
    case "select":
      return selectWallet(id);
    case "show-create":
      state.view = "create";
      loadMinDeposit().then(render);
      return render();
    case "pause":
      return run(() => call(leash, "pause", {}), "Paused. The agent can't spend until you resume it.");
    case "unpause":
      return run(() => call(leash, "unpause", {}), "Resumed. The agent can spend within its rules again.");
    case "approve":
      return run(() => call(leash, "approve", { id }, { tgas: 60 }), "Approved and sent.");
    case "reject":
      return run(() => call(leash, "reject", { id }), "Rejected. Nothing was sent.");
    case "remove-recipient":
      return run(() => call(leash, "remove_recipient", { account: id }), `Removed ${id}.`);
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "c-name") {
    const v = e.target.value.trim();
    $("c-name-preview").textContent = v
      ? `Your wallet's account will be ${v}.${cfg.factoryId}`
      : "Lowercase letters, numbers, - and _.";
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const leash = state.selected;
  try {
    switch (form.dataset.form) {
      case "open": {
        const id = accountId(form.id.value, "Account");
        if (!state.opened.includes(id)) {
          state.opened.push(id);
          saveOpened();
        }
        return selectWallet(id);
      }
      case "create": {
        const name = form.name.value.trim();
        if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(name) || name.length < 2 || name.length > 32) {
          throw new Error("Wallet names are 2 to 32 lowercase letters, numbers, - or _, and can't start or end with - or _.");
        }
        const agent = accountId(form.agent.value, "Agent account");
        if (agent === state.account) throw new Error("The agent must be a different account from yours.");
        const limits = limitsFromForm(form);
        const recipients = form.recipients.value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((r) => accountId(r, "Recipient"));
        const deposit = nearToYocto(form.deposit.value);
        if (state.minDeposit && BigInt(deposit) < BigInt(state.minDeposit)) {
          throw new Error(`The starting deposit must be at least ${near(state.minDeposit)}.`);
        }
        const newId = `${name}.${cfg.factoryId}`;
        return run(async () => {
          await call(cfg.factoryId, "create_leash", { name, agent, ...limits, recipients }, { deposit, tgas: 200 });
          await loadMyLeashes();
          if (!state.myLeashes.includes(newId)) {
            throw new Error(`Couldn't create ${newId}. The name may be taken. Your deposit was refunded.`);
          }
          selectWallet(newId);
        }, `Created ${newId}.`);
      }
      case "add-recipient": {
        const id = accountId(form.id.value, "Account");
        return run(() => call(leash, "add_recipient", { account: id }), `Added ${id}. The agent can now pay it.`);
      }
      case "limits": {
        const limits = limitsFromForm(form);
        return run(() => call(leash, "set_limits", limits), "Rules saved.");
      }
      case "agent": {
        const id = accountId(form.id.value, "Agent account");
        return run(() => call(leash, "set_agent", { agent: id }), `The agent is now ${id}.`);
      }
      case "withdraw": {
        const amount = nearToYocto(form.amount.value);
        if (BigInt(amount) > BigInt(state.data.available)) {
          throw new Error(`You can withdraw up to ${near(state.data.available)}.`);
        }
        return run(() => call(leash, "withdraw", { amount }), `Sent ${near(amount)} to the owner.`);
      }
    }
  } catch (err) {
    showNotice(err.message, true);
  }
});

// ---------------------------------------------------------------------------

// Coming back from a wallet popup: refresh so the page shows what was just signed.
window.addEventListener("focus", () => {
  if (!state.busy && state.view === "wallet" && state.selected) loadWallet(state.selected);
});

render();
if (state.view === "create") loadMinDeposit().then(render);
restoreSession().then(() => {
  render();
  if (state.view === "wallet" && state.selected) loadWallet(state.selected);
});
