---
name: Stripe revenue lane
description: Stand up a real money loop: product, checkout, webhook, fulfillment, ledger.
---

# Stripe revenue lane

## When to use
Selling a digital product or service and tracking real revenue.
## Steps
- Store the Stripe key in the vault (/api/vault/set stripe_secret).
- Create a checkout link (/api/store/checkout {name, amount_usd}).
- On payment, the webhook auto-fulfills and logs to the revenue ledger.
- Review P&L via /api/revenue/summary and the Operator HUD.
## Guardrails
- stripe_op is RED-tier — every charge needs explicit approval.
- Never expose the key; the vault is encrypted at rest.
