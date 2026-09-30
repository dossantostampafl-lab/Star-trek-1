---
name: Medir repositório
slug: codebase-inspection
description: Mede um repositório: linhas de código, linguagens e proporção de comentários.
category: Código
requires: [shell]
source: Hermes Agent, © 2025 Nous Research (MIT)
license: MIT
default: false
original: Codebase Inspection
---

Answer "how big is this repo?" with real numbers: lines of code, a language breakdown, file counts, and code-vs-comment ratios, using `pygount`.

Use when the Commander asks for a LOC count, a language breakdown, codebase size/composition, or comment ratios.

## Setup
```bash
pip install --break-system-packages pygount 2>/dev/null || pip install pygount
```

## Basic summary (most common)
```bash
cd /path/to/repo
pygount --format=summary \
  --folders-to-skip=".git,node_modules,venv,.venv,__pycache__,.cache,dist,build,.next,.tox,.eggs" \
  .
```
**Always pass `--folders-to-skip`** — without it, pygount crawls dependency/build dirs and hangs. Tune the list to the project type (add `target` for Rust, `Pods` for iOS, etc.).

## Useful variants
- Per-file detail: drop `--format=summary` for a line-by-line table, or `--format=cloc-xml` / `--format=json` to pipe into further analysis.
- Just the top languages: pipe the summary through `sort`/`head` on the code column.

## Reading it
The summary gives, per language: file count, code lines, documentation (comment) lines, empty lines. A very low doc:code ratio flags under-documented code; a very high one can flag generated or boilerplate-heavy files. Report the totals plus the 3-4 dominant languages — that's the "shape" of the repo.
