---
name: Tradução cuidadosa
slug: translation-pass
description: Traduz pelo sentido e pelo tom, adapta expressões e mantém a terminologia.
category: Escrita
requires: []
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Translation Pass
---

Translate so the result reads like it was written by a native speaker, while the meaning stays exact. Word-for-word is a trap; a stiff literal render is a failed translation.

## Method
1. **Read the whole document first (read_file).** Understand meaning, register, and audience before translating a line.
2. **Translate for meaning.** Render idiom, tone, and nuance naturally in the target language — not the source's grammar wearing new words.
3. **Localize.** Adapt dates, units, currency, names, and formatting conventions to the target locale.
4. **Hold terminology.** Keep a glossary for names, product terms, and jargon so the same term renders the same way throughout. Do NOT translate what should stay in the source language — code, brand names, identifiers.
5. **Preserve structure.** Keep markup, placeholders, and layout exactly; translate only the content.

## Rules
- **Never fabricate meaning** to fill an unclear passage — flag ambiguity with a note instead of guessing.
- **Consistency over cleverness** — the glossary wins over a nicer one-off phrasing.
- Maintain the glossary and per-locale preferences in notebook_write across documents.
- Save the result with write_file, preserving the original's format.

## Output
The translated document saved to a file, plus a short note of any terms left untranslated or flagged as ambiguous.
