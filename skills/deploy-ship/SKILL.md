---
name: Deploy & ship
description: Build and deploy to Vercel / GitHub / Pages and return the live URL.
---

# Deploy & ship

## When to use
A build is ready to go live.
## Steps
- Build the project; confirm it runs locally.
- Deploy (/api/deploy/run): Vercel, GitHub repo+push, or Pages.
- Return the live URL; log honest errors if a CLI/token is missing.
## Guardrails
- Live deploys are an outward action — confirm before shipping.
