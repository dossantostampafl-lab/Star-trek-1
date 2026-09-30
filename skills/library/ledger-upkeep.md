---
name: Livro-caixa
slug: ledger-upkeep
description: Lança e concilia um livro-caixa com totais calculados — nunca "no olho".
category: Dinheiro
requires: [shell]
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Ledger Upkeep
---

Keep the books straight: log entries, tally categories, reconcile against the prior balance, and flag anything that does not add up. Every total is computed; no figure is ever invented to make it balance.

## Method
1. **Read current state (read_file).** Understand the ledger's format, columns, and running totals before touching it.
2. **Add entries.** Append new records with write_file / write_file, preserving the existing structure and categories exactly.
3. **Compute, don't eyeball (shell).** Sum, categorize, and reconcile in a script over the file. Cross-check the new balance against the prior one.
4. **Reconcile.** Compare computed totals to expected; identify any gap. Categorize each entry consistently.
5. **Flag anomalies.** Duplicates, missing entries, a figure that does not reconcile — surface it; do not silently absorb it.

## Rules
- **Never invent, estimate, or adjust a number to force a balance.** If it does not reconcile, report the discrepancy.
- **Preserve history** — do not rewrite past entries silently; confirm before any write that alters them.
- Keep categories, recurring items, and budget rules in notebook_write for consistent classification.
- Show your arithmetic — the totals must be reproducible from the entries.

## Output
The updated totals / budget status, the entries added, and any discrepancy flagged for the Commander's review.
