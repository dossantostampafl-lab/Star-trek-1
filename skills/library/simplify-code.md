---
name: Simplificar código
slug: simplify-code
description: Deixa o código menor e mais claro — reusar, apagar, achatar — sem mudar o comportamento.
category: Código
requires: []
source: Hermes Agent, © 2025 Nous Research (MIT)
license: MIT
default: false
original: Simplify Code
---

Reduce code to the simplest version that still does the job. Simpler code has fewer places to hide bugs and reads faster. Behavior must not change.

## What to look for
- **Duplication** → extract one helper, or reuse an existing one. Search first (list_files) — the helper may already exist.
- **Dead code** → unused variables, functions, branches, imports, flags. Delete them.
- **Deep nesting** → flatten with early returns / guard clauses instead of `else` pyramids.
- **Over-abstraction** → a one-call "framework", needless indirection, a class that should be a function. Inline it.
- **Reinvented stdlib** → replace hand-rolled loops with the language's built-ins (map / filter / find, etc.).
- **Comments that explain confusing code** → often the code should be made clearer instead of annotated.
- **Boolean / null gymnastics** → simplify conditionals; prefer the positive form.

## Rules
- **Behavior-preserving only.** This is refactoring, not redesign. Any existing test must stay green; if none exists and the area is risky, write one first (or use the Test-Driven Development skill).
- **Match the surrounding style.** The result should read like the code around it — same naming, idioms, and comment density.
- **Small, reviewable diffs.** One kind of simplification at a time; show what you removed and why.
- **Read before you cut.** Confirm something is truly unused across the codebase (list_files) before deleting it.

## Flow
Read the target (read_file) → spot the simplifications above → apply with write_file (targeted) → state what shrank and confirm behavior is unchanged.
