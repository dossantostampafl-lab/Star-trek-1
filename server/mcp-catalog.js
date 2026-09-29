'use strict';
/* server/mcp-catalog.js — conectores MCP recomendados, instaláveis com um toque no painel.
   Cada entrada diz: como rodar (npx local ou URL remota), que chave pede (se pedir), para quais tripulantes
   vai por padrão e se é "seguro" (só lê/consulta) — os seguros podem ser liberados sem perguntar.
   Pacotes conferidos no npm em 2026-09-29. Os locais rodam com npx dentro do container (baixa na 1ª vez). */

const CATALOG = [
  {
    id: 'memoria', title: 'Memória da tripulação', badge: 'grátis · sem chave', safe: true,
    description: 'Um caderno de conhecimento compartilhado: os tripulantes guardam fatos, pessoas e decisões e consultam depois. Sobrevive a reinícios.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    env: (ctx) => ({ MEMORY_FILE_PATH: ctx.dataDir + '/mcp-memoria.jsonl' }),
    crew: ['Capitão', 'Pesquisadora', 'Redator', 'Revisor', 'Engenheira'], fields: []
  },
  {
    id: 'raciocinio', title: 'Raciocínio em etapas', badge: 'grátis · sem chave', safe: true,
    description: 'Ajuda o modelo a quebrar problemas difíceis em passos e revisar o próprio plano antes de agir. Bom para modelos grátis.',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    crew: ['Capitão', 'Engenheira'], fields: []
  },
  {
    id: 'docs', title: 'Documentação de bibliotecas (Context7)', badge: 'grátis · chave opcional', safe: true,
    description: 'Documentação atualizada de milhares de bibliotecas (React, FastAPI, Supabase…) direto para o agente — evita código com API velha.',
    transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'],
    crew: ['Engenheira', 'Pesquisadora'],
    fields: [{ key: 'CONTEXT7_API_KEY', label: 'Chave Context7 (opcional, aumenta o limite)', optional: true, secret: true, env: true, link: 'https://context7.com/dashboard' }]
  },
  {
    id: 'deepwiki', title: 'DeepWiki (repositórios do GitHub)', badge: 'grátis · sem chave', safe: true,
    description: 'Explica qualquer repositório público do GitHub: estrutura, como funciona, onde fica cada coisa. Remoto, não instala nada.',
    transport: 'http', url: 'https://mcp.deepwiki.com/mcp',
    crew: ['Engenheira', 'Pesquisadora'], fields: []
  },
  {
    id: 'tavily', title: 'Busca na web (Tavily)', badge: 'grátis 1.000/mês · chave', safe: true,
    description: 'Busca feita para agentes: resultados limpos, com trechos e extração de página. Bem mais confiável que a busca embutida.',
    transport: 'stdio', command: 'npx', args: ['-y', 'tavily-mcp'],
    crew: ['Pesquisadora'],
    fields: [{ key: 'TAVILY_API_KEY', label: 'Chave Tavily (tvly-…)', secret: true, env: true, link: 'https://app.tavily.com/home' }]
  },
  {
    id: 'brave', title: 'Busca Brave', badge: 'plano grátis · chave', safe: true,
    description: 'Busca web e notícias pelo índice próprio do Brave. Alternativa ou complemento ao Tavily.',
    transport: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'],
    crew: ['Pesquisadora'],
    fields: [{ key: 'BRAVE_API_KEY', label: 'Chave Brave Search', secret: true, env: true, link: 'https://brave.com/search/api/' }]
  },
  {
    id: 'firecrawl', title: 'Leitura de sites (Firecrawl)', badge: 'créditos grátis · chave', safe: true,
    description: 'Lê páginas difíceis (com JavaScript), rastreia sites inteiros e devolve Markdown limpo.',
    transport: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'],
    crew: ['Pesquisadora'],
    fields: [{ key: 'FIRECRAWL_API_KEY', label: 'Chave Firecrawl (fc-…)', secret: true, env: true, link: 'https://www.firecrawl.dev/app/api-keys' }]
  },
  {
    id: 'github', title: 'GitHub', badge: 'grátis · token', safe: false,
    description: 'Repositórios, issues, pull requests e código do seu GitHub (servidor oficial remoto). Pode criar e alterar coisas — pede permissão a cada uso.',
    transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    crew: ['Engenheira'],
    fields: [{ key: 'authorization', label: 'Token do GitHub (github_pat_… ou ghp_…)', secret: true, header: true, prefix: 'Bearer ', link: 'https://github.com/settings/personal-access-tokens' }]
  },
  {
    id: 'notion', title: 'Notion', badge: 'grátis · token', safe: false,
    description: 'Lê e escreve páginas e bancos do seu Notion. Compartilhe as páginas com a integração antes de usar.',
    transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'],
    crew: ['Redator'],
    fields: [{ key: 'NOTION_TOKEN', label: 'Token da integração Notion (ntn_…)', secret: true, env: true, link: 'https://www.notion.so/profile/integrations' }]
  },
  {
    id: 'supabase', title: 'Supabase', badge: 'grátis · token', safe: false,
    description: 'Consulta tabelas, roda SQL e lê logs dos seus projetos Supabase. Instalado em modo só-leitura por segurança.',
    transport: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase', '--read-only'],
    crew: ['Engenheira'],
    fields: [{ key: 'SUPABASE_ACCESS_TOKEN', label: 'Token pessoal Supabase (sbp_…)', secret: true, env: true, link: 'https://supabase.com/dashboard/account/tokens' }]
  }
];

function publicCatalog(installedNames) {
  const set = new Set(installedNames || []);
  return CATALOG.map(c => ({
    id: c.id, title: c.title, badge: c.badge, description: c.description, safe: c.safe, transport: c.transport,
    crew: c.crew, installed: set.has(c.id),
    fields: c.fields.map(f => ({ key: f.key, label: f.label, optional: !!f.optional, secret: !!f.secret, link: f.link || '' }))
  }));
}

// Monta a linha do banco (mcp_servers) a partir da entrada do catálogo e dos valores digitados.
function buildServer(id, values, ctx) {
  const c = CATALOG.find(x => x.id === id);
  if (!c) throw new Error('conector desconhecido: ' + id);
  values = values || {};
  const env = Object.assign({}, typeof c.env === 'function' ? c.env(ctx) : (c.env || {}));
  const headers = {};
  for (const f of c.fields) {
    const v = String(values[f.key] == null ? '' : values[f.key]).trim();
    if (!v) { if (f.optional) continue; throw new Error('preencha: ' + f.label); }
    if (/[\r\n]/.test(v)) throw new Error('valor inválido em ' + f.label);
    if (f.env) env[f.key] = v;
    if (f.header) headers[f.key] = (f.prefix && !v.toLowerCase().startsWith(f.prefix.toLowerCase()) ? f.prefix : '') + v;
  }
  return { entry: c, row: { name: c.id, transport: c.transport, command: c.command || '', args: c.args || [], env, url: c.url || '', headers } };
}

module.exports = { CATALOG, publicCatalog, buildServer };
