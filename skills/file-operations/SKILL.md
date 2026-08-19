---
name: File operations
description: Read, write, edit, and search files safely in the workspace sandbox.
---

# File operations

## When to use
Any task that creates, edits, inspects, or searches files on this machine.
## Steps
- Use file_write for new/changed files (sandboxed; auto-checkpointed for rollback).
- Read before overwriting; preserve surrounding style and structure.
- For multi-file work, plan the file list first, then write each, then verify.
## Guardrails
- Stay inside the workspace; never touch system or credential paths.
- Every write is checkpointed — use /api/checkpoints/rollback to undo.
