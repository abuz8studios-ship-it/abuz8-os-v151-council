---
name: Local coding loop
description: Build software with the offline coder loop: plan, write full files, run, read errors, repair.
---

# Local coding loop

## When to use
Building or fixing an app/script/tool, especially offline.
## Steps
- Plan the architecture and file list.
- Write complete files (no placeholders), then run build/tests.
- Read real errors, repair, and loop until green.
## Guardrails
- Prefer the local brain when no frontier provider is connected.
- Run only dev-toolchain commands; destructive commands are guarded.
