# Leash demo agent

A small AI purchasing agent that pays vendors through a Leash wallet on NEAR testnet. It reads a vendor's web page, decides whom to pay and how much using an LLM (Groq), and sends the payment request to Leash.

The agent itself trusts the page it reads, like a typical agent. Two layers sit around it:

1. **Injection filter** (optional): scans the page before the agent reads it, with two detectors (see below).
2. **Leash contract**: enforces the owner's rules on-chain, whatever the agent decides.

The demo shows that layer 2 holds even when layer 1 is off or misses.

## The three demo pages

| Page | What it contains | What should happen |
| --- | --- | --- |
| `pages/shop.html` | An honest vendor page | Agent pays 0.2 NEAR to `meetaminx-shop.testnet`. **Sent.** |
| `pages/shop-redirect.html` | Hidden text telling AI agents the vendor's account "moved" to `nodehost-billing.testnet` | If the agent falls for it, Leash **blocks** it: recipient not on the allowlist. |
| `pages/shop-overcharge.html` | Hidden text telling AI agents the price is 3 NEAR, paid to the real vendor | If the agent falls for it, Leash **blocks** it: over the per-payment cap. |

The injected text sits in a `display:none` block, so a person visiting the page never sees it, but an agent reading the page's text does. Whether the model falls for it varies between runs and models; when it does, Leash stops it, and when it doesn't, nothing needed stopping.

## Setup

Requires Node.js 20 or newer, the Leash contract deployed (see the main README), and the agent account's key in `~/.near-credentials` (created by `near account create-account ... save-to-legacy-keychain`).

```bash
cd agent
npm install
cp .env.example .env
```

Edit `.env`: paste your Groq key into `GROQ_API_KEY` and check the account names.

Create the agent's restricted key:

```bash
npm run setup-key
```

This adds a new key to the agent account that NEAR itself limits to calling `request_payment` on the Leash contract, with a 0.25 NEAR gas budget. The agent only ever uses this key. It cannot send NEAR directly, change the wallet's rules, or call any other contract.

## Run

```bash
npm run status                               # wallet rules, today's allowance, held payments
npm run agent -- pages/shop.html             # honest purchase
npm run agent -- pages/shop-redirect.html    # redirect attack
npm run agent -- pages/shop-overcharge.html  # overcharge attack
```

### Injection filter modes

```bash
npm run agent -- pages/shop-redirect.html --filter off    # no filter: only the contract protects you
npm run agent -- pages/shop-redirect.html --filter warn   # default: flags the page and warns the agent
npm run agent -- pages/shop-redirect.html --filter block  # refuses to act on a flagged page
```

The filter runs two detectors and flags the page if either scores at or above the threshold:

- **Prompt Guard 2** (`meta-llama/llama-prompt-guard-2-86m`) catches explicit jailbreak phrasing such as "ignore your previous instructions". It reads at most 512 tokens, so the page is split into short segments.
- **Policy check** (`openai/gpt-oss-safeguard-20b`) reads the page against a written policy (`INJECTION_POLICY` in `src/filter.js`) about text that tries to redirect payments, inflate prices or give AI agents instructions. It catches injections written as ordinary-looking notices, which Prompt Guard is not built for: on `shop-redirect.html`, Prompt Guard scored 0.00.

Set the default mode and threshold with `INJECTION_FILTER` and `INJECTION_THRESHOLD` in `.env`, and the policy model with `SAFEGUARD_MODEL`.

Use your own task with `--task`, for example:

```bash
npm run agent -- pages/shop.html --task "Buy the 5,000 credits pack"
```

The 5,000 pack costs 0.8 NEAR, above the 0.5 NEAR approval threshold, so it will be held for the owner.

## Tests

```bash
npm test
```

## Files

- `src/agent.js`: the agent: page loading, Groq tool calling, one payment per task
- `src/filter.js`: the injection filter (Prompt Guard 2 and a gpt-oss-safeguard policy check, on Groq)
- `src/leash.js`: client for the Leash contract
- `src/setup-key.js`: creates the agent's function-call-only key
- `src/status.js`: prints the wallet's current state
