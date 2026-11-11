# Leash dashboard

A web page for Leash wallet owners. Connect a NEAR wallet, then:

- create a Leash wallet through the factory, with its agent, limits and approved recipients
- see how much the agent can still spend today, against the approval limit and per-payment cap
- approve or reject payments waiting for approval
- add and remove approved recipients, change the rules, swap the agent, pause, and withdraw

Anyone can open a wallet by its account to view it. Only the owner sees the controls.

Wallet connection uses [NEAR Connect](https://github.com/hot-dao/near-connect). Reads go straight to the NEAR RPC.

## Run it

```bash
cd dashboard
npm install
cp .env.example .env    # set VITE_FACTORY_ID to your factory account
npm run dev
```

Open http://localhost:5173.

To sign in with an account you created with the NEAR CLI, import its key into a browser wallet that supports testnet (for example Meteor Wallet, "import with private key"). The key is in `~/.near-credentials/testnet/<account>.json`. Only do this with testnet accounts.

## Build

```bash
npm run build    # outputs dist/
npm test         # amount conversion and error parsing tests
```

## Files

- `src/main.js`: wallet connection, views and actions
- `src/near.js`: RPC reads, NEAR amount conversion, contract error parsing
- `src/style.css`: styles
