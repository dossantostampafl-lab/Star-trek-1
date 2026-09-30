---
name: Plano de estudos
slug: study-plan
description: Cria um plano de estudos por etapas, do nível atual até um objetivo concreto.
category: Pesquisa
requires: [web]
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Study Plan
---

Get the Commander from where they actually are to a concrete goal, in ordered steps with checkpoints. A plan they can follow beats a reading list they will abandon.

## Method
1. **Gauge the start and the end.** Their current level and the specific goal. Teaching over their head or under it both waste time — ask if unclear.
2. **Map the path (web_search / fetch_url).** Identify the real prerequisites and sequence; verify a curriculum against credible sources rather than guessing the order.
3. **Break into milestones.** Each milestone: what to learn, one good resource, and a checkpoint that proves it stuck (a small exercise or question).
4. **Pace it.** Fit the milestones to the Commander's available time; front-load fundamentals.
5. **Persist it.** Write the plan to a file with write_file so it survives the session.

## Rules
- **Verify facts and resource quality** — do not recommend a source you have not confirmed exists and fits.
- **Checkpoints, not just readings** — every milestone ends in a way to test understanding.
- Track progress and sticking points in notebook_write so each session resumes correctly.
- If a topic is genuinely contested or you are unsure of the best path, say so.

## Output
An ordered milestone plan (goal → milestones, each with resource + checkpoint), saved to a file, plus a suggested pace.
