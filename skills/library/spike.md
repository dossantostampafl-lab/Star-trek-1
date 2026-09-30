---
name: Experimento rápido
slug: spike
description: Experimentos descartáveis para validar uma ideia antes de construir de verdade.
category: Código
requires: [shell]
source: gsd-build, get-shit-done (MIT)
license: MIT
default: false
original: Spike
---

Use this when the Commander wants to *feel out an idea* before committing — validating feasibility, comparing approaches, surfacing unknowns that no amount of reading answers. Spikes are disposable by design; throw them away once they've paid their debt.

Triggers: "let me try this", "see if X works", "spike this out", "quick prototype of Z", "is this even possible?", "compare A vs B".

## When NOT to spike
- The answer is knowable from docs or reading code — just research.
- It's the production path — plan and build it properly instead.
- The idea is already validated — go straight to implementation.

## The loop
```
decompose → research → build → verdict   (iterate on findings)
```

### 1. Decompose
Break the idea into 2-5 independent feasibility questions; each question is one spike. Frame each Given/When/Then with a risk level. **Order by risk** — the spike most likely to KILL the idea runs first. No point prototyping the easy parts if the hard part fails. Skip decomposition only if they already know exactly what to spike.

### 2. Align (multi-spike)
Show the spike table, ask "build all in this order, or adjust?" Let them drop/reorder before any code is written.

### 3. Research (per spike, just enough)
Brief it in 2-3 sentences. If there's real choice of approach, surface competing libraries in a small pros/cons table with a maintained/abandoned status, pick one, say why. Use `web_search` for candidates, `fetch_url` to read the actual docs, and `shell` to check what's already installed. Skip research for pure logic with no external deps.

### 4. Build
One standalone directory per spike (`spikes/001-<name>/`). Smallest thing that answers the question — hardcode, skip edge cases, no polish. Run it with `shell` / `shell`.

### 5. Verdict
Per spike, write the Given/When/Then result: **PASS / FAIL / PARTIAL**, the observed evidence, and what it means for the real build. Then delete the spike code (keep only the verdict). A spike that taught you the idea won't work is a *success*.
