---
name: Auditoria de gastos
slug: cost-audit
description: Revisa gastos item a item, confere alternativas mais baratas e ordena a economia.
category: Dinheiro
requires: [web]
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Cost Audit
---

Find the same result cheaper — with every number computed from real records and every alternative verified against a live price. An audit that guesses is worse than no audit.

## Method
1. **Read the real records first (read_file).** The actual expense list, invoices, or subscription export — never audit from memory of what the Commander "probably pays".
2. **Interrogate each line:** what is it for, is it still used, and what tier is it on. Zombie subscriptions and forgotten tiers are the usual gold.
3. **Price the alternatives live (web_search → fetch_url).** Open the real pricing page for each candidate; compare the TOTAL (fees, limits, seat counts), not the sticker. Note the as-of date.
4. **Rank the findings** by annual savings and switching effort. A $5/mo saving that costs a day of migration is not a win — say so.
5. **Recommend the top 3 moves** with the exact action (cancel X, downgrade Y to tier Z, switch W to alternative Q at $N).

## Rules
- **Never estimate a number you can read** — totals come from the records, prices from live pages.
- Flag anomalies (duplicates, price creep, unreconciled figures) plainly; never smooth them over.
- The Commander executes the switches — you recommend and evidence, never cancel or purchase anything yourself.

## Output
Total spend as computed, the ranked savings table (item · current · alternative · annual saving · effort · source), then the top-3 moves and the anomalies held for review.
