---
name: Comparar preços
slug: price-watch
description: Busca preços atuais comparáveis, calcula o custo total real e diz se compra ou espera.
category: Dinheiro
requires: [web]
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Price Watch
---

Find the real price the Commander would actually pay, compare honest apples to apples, and give a clear call. Every number is one you fetched off a page — never a remembered or invented figure.

## Method
1. **Pin the exact item.** Model, spec, size, condition. A cheaper near-match is a different product — flag it if you substitute.
2. **Gather live prices (web_search → fetch_url).** Open the real listing for each and read the price off the page. Do not quote a search-snippet price without opening it.
3. **Total it honestly.** Add fees, shipping, tax, and terms — the sticker is not the cost. Compare like-for-like across ≥3 sellers.
4. **Read the trend.** Against your recorded history, is this high, low, or moving? Note stock and deadline risk.
5. **Call it.** Buy now, wait, or which option — with the reason.

## Rules
- **Every price cites its source, seller, and date.** No live price found → say so, never guess.
- **Never invent a discount, coupon, or URL.**
- Record each observation (price, seller, timestamp) to notebook_write so next pass can tell what moved.
- Save a comparison sheet with write_file when the Commander is weighing options.

## Output
The call up front (buy / wait / which one), then a price table — item · seller · total · source · date — then the caveats.
