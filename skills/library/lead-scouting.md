---
name: Prospectar clientes
slug: lead-scouting
description: Descobre onde o cliente ideal está e monta listas de contatos com evidências públicas.
category: Negócios
requires: [web, notebook]
source: StarNet, © 2026 Andrew Sims (MIT)
license: MIT
default: false
original: Lead Scouting
---

Fill the pipeline with leads that are real, qualified, and traceable to a page you actually opened. Ten qualified leads beat two hundred cold names.

## Method
1. **Pin the ICP.** Who exactly, the pain they have, and the signal that says they can pay. Prospecting without an ideal customer profile is spam.
2. **Hunt sources, not names, first (web_search).** Directories, communities, review sites, job boards, social groups — the places this ICP already gathers. Rank sources by density of fit.
3. **Verify every lead on the live page (fetch_url).** A lead you did not see on a page does not go on the list.
4. **Qualify each entry:** the fit signal, the evidence link, and one personalization hook for outreach (something specific you saw).
5. **Track source hit-rates in notebook_write** — which sources produced leads that converted — and mine the winners first next pass.

## Rules
- **Public information only.** Nothing behind logins; no personal data beyond what is published for business contact.
- **Never invent a contact, company, or URL.** No verified source → the lead does not exist.
- Rank by fit, not list length.

## Output
The ranked list (name · source link · fit signal · hook), the best 3 with outreach angles, then which source to mine next and why.
