---
name: Conferir antes de entregar
slug: requesting-code-review
description: Verifica as próprias mudanças: varredura de segurança, testes e uma revisão independente.
category: Código
requires: [shell]
source: obra/superpowers + MorAlekss (MIT)
license: MIT
default: false
original: Pre-Commit Verification
---

A verification pipeline to run before code lands. **Core principle: no one verifies their own work well from the same context.** Re-read the diff with fresh eyes, as an adversary would.

Use after implementing a feature or fix, before commit/push, or when the Commander says "commit", "ship", "done", or "review before merge". Skip for docs-only or pure-config tweaks.

## Step 1 — Get the diff
`shell("git diff --cached")`. Empty? Try `git diff`, then `git diff HEAD~1 HEAD`. If `--cached` is empty but `git diff` has changes, tell them to stage first. If the diff is huge (>15k chars), split by file (`git diff --name-only`, then per file).

## Step 2 — Static security scan (added lines only)
Grep the added lines for: hardcoded secrets / API keys / passwords, `eval`/`exec` on untrusted input, SQL built by string concat, shelling out with unsanitised input, missing authorization checks, secrets logged in plaintext. Any hit is a finding for Step 4.

## Step 3 — Quality gates
Run the project's real gates with `shell` / `shell`: linter, type-checker, and the test suite. A gate that was already red before your change is a baseline, not a new failure — note it, don't chase it.

## Step 4 — Independent review pass
Re-read the diff as if someone else wrote it. Correctness first (off-by-one, null, wrong boundary, race, unhandled error, resource leak, logic that doesn't match intent), then contract (does it do what was asked?), then tests (would they fail if the code were wrong?), then clarity. Every finding names file:line and a concrete fix, tagged blocker vs nit.

## Step 5 — Fix loop
Fix the blockers, re-run the gates until green, re-scan. Then report a short verdict: safe to commit? blockers remaining? what you changed.
