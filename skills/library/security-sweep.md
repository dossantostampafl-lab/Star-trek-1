---
name: Varredura de segurança
slug: security-sweep
description: Procura segredos expostos, injeção e falhas de autorização — cada achado demonstrado.
category: Código
requires: [shell]
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Security Sweep
---

Hunt the security holes and leaked secrets in a codebase, and report only what you can show. A confident-but-wrong flag erodes trust as fast as a missed bug.

## Method
1. **Scope it.** What tree, and what you are hunting: secrets, injection, missing authorization, unsafe eval/exec, config drift.
2. **Read broadly (list_files / read_file).** Grep the classics — hardcoded keys/tokens/passwords, `eval`/`exec` on untrusted input, string-built SQL/shell, missing auth checks, permissive CORS, `.env` and key files committed.
3. **Confirm each finding.** Reproduce it or trace the exact reachable path (shell). Unreachable code is a lower-severity note, not an exploit.
4. **Rank by severity.** Critical (exploitable / leaked live secret) → high → nit. Separate real risk from style.
5. **Remediate.** Each finding gets a concrete fix.

## Rules
- **Never print a discovered secret's value** — cite its file:line location only.
- **Demonstrated, not suspected** — if you cannot show reachability, mark it "suspected".
- **No invented findings** to look thorough; if the sweep is clean, say so.
- Log scope, findings, and fix status to notebook_write so the next sweep tracks what was resolved.

## Output
A risk summary up front, then findings grouped critical → nit, each with file:line, the risk, how you confirmed it, and the remediation.
