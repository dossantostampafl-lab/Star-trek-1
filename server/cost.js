'use strict';
/* server/cost.js — custo em US$ por chamada ao modelo e controle de orçamento.
   FreeLLMAPI e modelos locais (Ollama) custam 0. Preços por 1 milhão de tokens (entrada / saída),
   tabela de referência — confira no site do provedor se precisar de precisão. */

const PRICES = [
  [/claude-(opus|fable|mythos)-5/i, { in: 5, out: 25 }],
  [/claude-opus-4/i, { in: 15, out: 75 }],
  [/claude-sonnet/i, { in: 3, out: 15 }],
  [/claude-haiku/i, { in: 1, out: 5 }],
  [/gpt-4o-mini|gpt-.*-mini/i, { in: 0.15, out: 0.6 }],
  [/gpt-4o|gpt-4\.1/i, { in: 2.5, out: 10 }],
  [/gpt-5/i, { in: 1.25, out: 10 }],
  [/deepseek/i, { in: 0.27, out: 1.1 }]
];

function priceFor(providerName, model) {
  if (providerName === 'freellmapi') return { in: 0, out: 0 };
  const base = String(process.env.OPENAI_BASE_URL || '');
  if (providerName === 'openai' && /localhost|127\.0\.0\.1/.test(base)) return { in: 0, out: 0 };   // Ollama etc.
  for (const [re, p] of PRICES) if (re.test(model || '')) return p;
  return null;   // desconhecido
}

function costOf(providerName, model, usage) {
  const p = priceFor(providerName, model);
  if (!p) return { usd: 0, known: false };
  return { usd: ((usage.input || 0) * p.in + (usage.output || 0) * p.out) / 1e6, known: true };
}

function fmtUsd(v) { return 'US$ ' + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)); }

module.exports = { costOf, priceFor, fmtUsd };
