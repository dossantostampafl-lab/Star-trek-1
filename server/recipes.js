'use strict';
/* server/recipes.js — biblioteca de receitas: tarefas prontas que você preenche em 1 minuto e manda para a tripulação.
   Inspirada no catálogo do StarNet (MIT). Cada receita tem:
   - params: campos do formulário ({chave} no texto da tarefa é trocado pelo valor)
   - task + steps: o pedido e o passo a passo que o tripulante deve seguir
   - skills: habilidades da biblioteca que ajudam (o tripulante lê com skill_view)
   - to: quem recebe ('captain' = Capitão, que delega; ou a função: research/writer/reviewer/engineer)
   - cadence: sugestão de rotina (cron) — "Virar rotina" cria um agendamento com a tarefa preenchida.
   Receitas próprias ficam no banco (tabela recipes) e usam {chave} no texto para gerar os campos. */

const T = (key, label, placeholder, extra) => Object.assign({ key, label, placeholder: placeholder || '', type: 'text', required: true }, extra || {});
const AREA = (key, label, placeholder, extra) => T(key, label, placeholder, Object.assign({ type: 'textarea' }, extra || {}));
const OPT = (key, label, options, def) => ({ key, label, type: 'choice', options, default: def || options[0], required: true });
const FILE = (key, label) => T(key, label, 'nome do arquivo em Arquivos → entrada/ (ex.: entrada/contrato.pdf)');

const CATALOG = [
  // ---------- Geral
  { id: 'resumir', name: 'Resumir um documento', emoji: '📄', category: 'Geral', to: 'research',
    blurb: 'Lê um arquivo enviado e entrega os pontos principais, o que exige ação e as dúvidas.',
    params: [FILE('arquivo', 'Arquivo'), OPT('tamanho', 'Tamanho do resumo', ['curto (5 tópicos)', 'médio (1 página)', 'detalhado'])],
    task: 'Leia {arquivo} (pasta compartilhada, use shared_read_file) e faça um resumo {tamanho}.',
    steps: ['Leia o documento inteiro antes de resumir', 'Liste os pontos principais em ordem de importância', 'Destaque prazos, valores e obrigações', 'Termine com "O que exige ação" e "Dúvidas"'],
    skills: [] },
  { id: 'letras-miudas', name: 'Achar a pegadinha', emoji: '🔎', category: 'Geral', to: 'reviewer',
    blurb: 'Contrato, oferta, termos de uso: aponta as cláusulas que podem te prejudicar.',
    params: [FILE('arquivo', 'Documento'), T('preocupacao', 'O que mais te preocupa', 'ex.: multa de cancelamento', { required: false })],
    task: 'Revise {arquivo} (use shared_read_file) procurando riscos para mim. Preocupação principal: {preocupacao}.',
    steps: ['Leia tudo, inclusive anexos e notas de rodapé', 'Liste cláusulas de risco citando o trecho exato', 'Classifique: alto / médio / baixo', 'Sugira o que perguntar ou negociar'],
    skills: ['contract-review'] },
  { id: 'prazos', name: 'Caçar prazos e vencimentos', emoji: '⏰', category: 'Geral', to: 'research',
    blurb: 'Varre documentos e monta uma lista de datas-limite, renovações e vencimentos.',
    params: [T('arquivos', 'Arquivos (um ou vários)', 'ex.: entrada/apolice.pdf, entrada/contrato.docx')],
    task: 'Leia {arquivos} e encontre todas as datas que importam: vencimentos, renovações automáticas, prazos de aviso e multas.',
    steps: ['Leia cada arquivo', 'Monte uma tabela: data | o quê | arquivo | o que fazer antes', 'Ordene da data mais próxima para a mais distante', 'Anote no caderno as datas críticas (notebook_write, pinned=true)'],
    skills: ['commitment-tracking'] },
  { id: 'viagem', name: 'Planejar viagem', emoji: '🧳', category: 'Geral', to: 'research',
    blurb: 'Roteiro dia a dia com horários, deslocamentos e custos conferidos.',
    params: [T('destino', 'Destino', 'ex.: Lisboa'), T('datas', 'Datas / duração', 'ex.: 12 a 16 de novembro'), T('estilo', 'Estilo e orçamento', 'ex.: museus, comida, R$ 6 mil', { required: false })],
    task: 'Planeje uma viagem para {destino} ({datas}). Estilo e orçamento: {estilo}.',
    steps: ['Pesquise atrações, horários e preços atuais', 'Monte o roteiro dia a dia agrupando por região', 'Inclua deslocamentos e tempo realista', 'Estime o custo total e salve em relatorios/viagem-{destino}.md'],
    skills: ['itinerary-planning'] },
  { id: 'cardapio', name: 'Cardápio da semana', emoji: '🥗', category: 'Geral', to: 'research',
    blurb: 'Refeições da semana com o que você já tem, mais a lista de compras.',
    params: [AREA('tenho', 'O que tem em casa', 'arroz, ovos, frango…'), T('restricoes', 'Restrições e gostos', 'ex.: sem lactose', { required: false }), OPT('pessoas', 'Pessoas', ['1', '2', '3', '4', '5+'], '2')],
    task: 'Monte o cardápio da semana para {pessoas} pessoa(s) usando primeiro o que tenho: {tenho}. Restrições: {restricoes}.',
    steps: ['Priorize o que estraga antes', 'Almoço e jantar, reaproveitando preparos', 'Lista de compras agrupada por seção do mercado'],
    skills: ['meal-planning'] },

  // ---------- Pesquisa
  { id: 'pesquisa-profunda', name: 'Pesquisa profunda', emoji: '🧭', category: 'Pesquisa', to: 'captain',
    blurb: 'Pesquisa com várias fontes, cruzamento de dados e relatório revisado.',
    params: [AREA('pergunta', 'Pergunta', 'O que você quer saber?'), T('uso', 'Para que vai usar', 'ex.: decidir fornecedor', { required: false })],
    task: 'Quero uma pesquisa profunda: {pergunta}. Vou usar para: {uso}. Passe para a Pesquisadora; o texto segue para Redator e Revisor.',
    steps: ['Quebrar em 3–5 sub-perguntas', 'Buscar fontes primárias e recentes', 'Confirmar cada fato importante em 2 fontes', 'Relatório com resposta no topo e links', 'Lista do que não foi possível confirmar'],
    skills: ['web-research', 'source-triangulation'] },
  { id: 'checar-fato', name: 'Checar um fato', emoji: '✅', category: 'Pesquisa', to: 'research',
    blurb: 'Confirma (ou derruba) uma afirmação com fontes independentes.',
    params: [AREA('afirmacao', 'Afirmação', 'Cole aqui o que você quer checar')],
    task: 'Cheque se isto é verdade: "{afirmacao}".',
    steps: ['Encontre a origem da afirmação', 'Procure 2+ fontes independentes', 'Veredito: verdadeiro / falso / enganoso / não confirmado', 'Explique em 3 linhas com os links'],
    skills: ['source-triangulation'] },
  { id: 'comparar-opcoes', name: 'Comparar opções', emoji: '⚖️', category: 'Pesquisa', to: 'research',
    blurb: 'Compara produtos, serviços ou ferramentas lado a lado e recomenda.',
    params: [T('opcoes', 'Opções', 'ex.: Supabase, Firebase, Appwrite'), T('criterios', 'Critérios', 'ex.: preço, limite grátis, facilidade')],
    task: 'Compare {opcoes} pelos critérios: {criterios}. Recomende uma para o meu caso.',
    steps: ['Dados atuais de fontes oficiais', 'Tabela comparativa', 'Prós e contras de cada', 'Recomendação com o motivo'],
    skills: ['web-research', 'decision-1-3-1'] },
  { id: 'artigo-cientifico', name: 'Explicar artigo científico', emoji: '🔬', category: 'Pesquisa', to: 'research',
    blurb: 'Busca e explica um artigo (arXiv ou PDF enviado) em linguagem simples.',
    params: [T('artigo', 'Artigo (título, link ou arquivo)', 'ex.: Attention Is All You Need')],
    task: 'Encontre e explique o artigo "{artigo}" em português simples.',
    steps: ['Problema que o artigo resolve', 'Método em linguagem simples', 'Resultados com números', 'Limitações', 'Por que importa na prática'],
    skills: ['arxiv-research'] },
  { id: 'plano-estudos', name: 'Plano de estudos', emoji: '🎓', category: 'Pesquisa', to: 'research',
    blurb: 'Do seu nível atual até um objetivo concreto, com materiais gratuitos.',
    params: [T('tema', 'O que aprender', 'ex.: FastAPI avançado'), T('nivel', 'Seu nível hoje', 'ex.: já fiz CRUD simples'), T('tempo', 'Tempo disponível', 'ex.: 5 h por semana, 2 meses')],
    task: 'Monte um plano de estudos de {tema}. Nível atual: {nivel}. Tempo: {tempo}.',
    steps: ['Metas por semana', 'Materiais gratuitos com link', 'Um projeto prático por etapa', 'Como saber que aprendeu (teste de cada etapa)'],
    skills: ['study-plan'] },
  { id: 'boletim', name: 'Boletim de novidades', emoji: '📰', category: 'Pesquisa', to: 'research', cadence: '0 8 * * 1-5',
    blurb: 'As novidades mais importantes de um assunto, com fontes. Ótimo como rotina.',
    params: [T('assunto', 'Assunto', 'ex.: e-commerce no Brasil'), OPT('periodo', 'Período', ['últimas 24 horas', 'última semana'])],
    task: 'Faça um boletim das novidades mais importantes sobre {assunto} ({periodo}).',
    steps: ['No máximo 5 itens', 'Um parágrafo curto por item, com o link', 'Por que isso importa para mim', 'Salve em relatorios/boletim-AAAA-MM-DD.md'],
    skills: ['digest-composer'] },

  // ---------- Escrita
  { id: 'responder-mensagem', name: 'Responder uma mensagem', emoji: '✉️', category: 'Escrita', to: 'writer',
    blurb: 'Rascunho de resposta no tom certo — você revisa e envia.',
    params: [AREA('mensagem', 'Mensagem recebida', 'Cole aqui'), T('objetivo', 'O que você quer com a resposta', 'ex.: recusar com educação'), OPT('tom', 'Tom', ['cordial', 'formal', 'direto', 'caloroso'])],
    task: 'Escreva uma resposta {tom} para a mensagem abaixo. Objetivo: {objetivo}.\n\nMensagem:\n{mensagem}',
    steps: ['Responda o que foi perguntado primeiro', 'Curta e clara', 'Duas versões: curta e completa'],
    skills: ['humanizer', 'voice-match'] },
  { id: 'melhorar-texto', name: 'Melhorar um texto', emoji: '✍️', category: 'Escrita', to: 'writer',
    blurb: 'Deixa o texto mais claro, curto e com cara de gente.',
    params: [AREA('texto', 'Texto', 'Cole aqui'), T('publico', 'Para quem é', 'ex.: clientes', { required: false })],
    task: 'Melhore este texto para {publico}, mantendo o sentido:\n\n{texto}',
    steps: ['Corte o que sobra', 'Frases diretas', 'Tire os vícios de texto de IA', 'Mostre a versão final e uma lista curta do que mudou'],
    skills: ['humanizer'] },
  { id: 'post-redes', name: 'Posts para redes', emoji: '📣', category: 'Escrita', to: 'writer',
    blurb: 'Um assunto vira posts adaptados para cada rede.',
    params: [AREA('assunto', 'Assunto / novidade', ''), T('redes', 'Redes', 'ex.: Instagram, LinkedIn, X')],
    task: 'Transforme isto em posts para {redes}: {assunto}',
    steps: ['Gancho na primeira linha', 'Adapte tamanho e tom a cada rede', 'Sugira hashtags e chamada para ação'],
    skills: ['announcement-kit', 'humanizer'] },
  { id: 'traduzir', name: 'Traduzir documento', emoji: '🌐', category: 'Escrita', to: 'writer',
    blurb: 'Tradução pelo sentido, com terminologia consistente.',
    params: [FILE('arquivo', 'Arquivo'), T('idioma', 'Para qual idioma', 'ex.: inglês americano')],
    task: 'Traduza {arquivo} para {idioma} e salve a tradução na pasta compartilhada.',
    steps: ['Glossário dos termos técnicos antes de traduzir', 'Traduza pelo sentido, não palavra por palavra', 'Revise números, nomes e formatação'],
    skills: ['translation-pass'] },
  { id: 'conversa-dificil', name: 'Mensagem difícil', emoji: '🫱', category: 'Escrita', to: 'writer',
    blurb: 'A mensagem que você está adiando: cobrança, limite, desculpa, má notícia.',
    params: [AREA('situacao', 'Situação', 'O que aconteceu e com quem'), T('resultado', 'Resultado que você quer', '')],
    task: 'Me ajude a escrever uma mensagem difícil. Situação: {situacao}. Quero chegar em: {resultado}.',
    steps: ['Clara e respeitosa', 'Sem rodeios nem agressividade', 'Duas versões de tom'],
    skills: ['hard-conversation'] },

  // ---------- Negócios
  { id: 'proposta-cliente', name: 'Proposta comercial', emoji: '🤝', category: 'Negócios', to: 'captain',
    blurb: 'Proposta pronta para enviar: escopo, prazos, valores e próximos passos.',
    params: [T('cliente', 'Cliente', ''), AREA('escopo', 'O que será entregue', ''), T('valor', 'Valor / condições', 'ex.: R$ 8.000 em 2x', { required: false })],
    task: 'Monte uma proposta comercial para {cliente}. Escopo: {escopo}. Valor: {valor}. Redator escreve, Revisor revisa.',
    steps: ['Problema do cliente em 2 linhas', 'Escopo e o que NÃO está incluso', 'Cronograma', 'Investimento e condições', 'Próximo passo claro'],
    skills: ['humanizer'] },
  { id: 'prospectar', name: 'Prospectar clientes', emoji: '🎯', category: 'Negócios', to: 'research',
    blurb: 'Onde está seu cliente ideal e uma lista de contatos com evidência pública.',
    params: [AREA('cliente_ideal', 'Cliente ideal', 'ex.: lojas de roupa no Shopee com 1–10 funcionários'), T('regiao', 'Região', 'ex.: Brasil', { required: false })],
    task: 'Encontre potenciais clientes com este perfil: {cliente_ideal}. Região: {regiao}.',
    steps: ['Onde esse público se reúne', '10–20 empresas com a evidência de cada', 'Só dados públicos e profissionais', 'Salve como planilha CSV'],
    skills: ['lead-scouting'] },
  { id: 'procedimento', name: 'Escrever procedimento (POP)', emoji: '📋', category: 'Negócios', to: 'writer',
    blurb: 'Transforma como você faz algo num passo a passo que outra pessoa segue.',
    params: [AREA('como_faco', 'Como você faz hoje', 'Descreva do seu jeito')],
    task: 'Transforme isto num procedimento operacional padrão:\n{como_faco}',
    steps: ['Objetivo e quando usar', 'Passos numerados e verificáveis', 'Erros comuns', 'Checklist final'],
    skills: ['sop-writing'] },
  { id: 'plano-marketing', name: 'Plano de marketing', emoji: '📈', category: 'Negócios', to: 'captain',
    blurb: 'Canais, campanhas e metas mensuráveis com base em pesquisa do público.',
    params: [T('produto', 'Produto / negócio', ''), T('meta', 'Meta', 'ex.: 50 vendas/mês'), T('verba', 'Verba mensal', 'ex.: R$ 1.000', { required: false })],
    task: 'Monte um plano de marketing para {produto}. Meta: {meta}. Verba: {verba}.',
    steps: ['Pesquisa rápida do público e concorrentes', 'Até 3 canais priorizados', 'Campanha por canal com meta', 'Calendário de 4 semanas'],
    skills: ['marketing-plan', 'content-calendar'] },
  { id: 'resumo-suporte', name: 'Resumo do suporte', emoji: '🎧', category: 'Negócios', to: 'research',
    blurb: 'Agrupa reclamações/perguntas e sugere respostas prontas e artigos de ajuda.',
    params: [FILE('arquivo', 'Arquivo com as mensagens')],
    task: 'Analise as mensagens de clientes em {arquivo}: agrupe por tema, conte, e escreva respostas modelo.',
    steps: ['Temas com contagem', 'Os 3 problemas mais urgentes', 'Resposta modelo para cada tema', 'Ideias de artigo de ajuda'],
    skills: ['support-replies'] },

  // ---------- Dinheiro
  { id: 'preco', name: 'Vigiar preço', emoji: '🏷️', category: 'Dinheiro', to: 'research', cadence: '0 10 * * *',
    blurb: 'Compara o preço total real em várias lojas e diz se compra ou espera.',
    params: [T('produto', 'Produto', 'ex.: iPad Air 11 M3 128 GB'), T('alvo', 'Preço-alvo', 'ex.: R$ 4.500', { required: false })],
    task: 'Pesquise o preço atual de {produto} em lojas confiáveis. Preço-alvo: {alvo}.',
    steps: ['Mesmo modelo exato em cada loja', 'Preço total com frete', 'Compare com o preço-alvo', 'Veredito: comprar agora ou esperar'],
    skills: ['price-watch'] },
  { id: 'assinaturas', name: 'Auditar assinaturas', emoji: '💳', category: 'Dinheiro', to: 'research',
    blurb: 'Lista assinaturas, o custo anual e onde dá para cortar ou trocar.',
    params: [AREA('lista', 'Suas assinaturas', 'ex.: Netflix R$ 55, Spotify R$ 22, iCloud R$ 15…')],
    task: 'Analise minhas assinaturas e diga onde economizar:\n{lista}',
    steps: ['Custo mensal e anual de cada', 'Planos mais baratos ou alternativas atuais', 'Sobreposições', 'Economia total possível'],
    skills: ['cost-audit'] },
  { id: 'orcamento', name: 'Montar orçamento', emoji: '🧮', category: 'Dinheiro', to: 'engineer',
    blurb: 'Planilha de orçamento mensal com totais calculados (não no olho).',
    params: [AREA('dados', 'Renda e gastos', 'Cole valores ou aponte um arquivo em entrada/')],
    task: 'Monte um orçamento mensal em CSV com estes dados: {dados}',
    steps: ['Categorias claras', 'Totais calculados por script', 'Destaque onde está acima do razoável', 'Salve orcamento.csv na pasta compartilhada'],
    skills: ['ledger-upkeep'] },
  { id: 'negociar', name: 'Negociar desconto', emoji: '🗣️', category: 'Dinheiro', to: 'writer',
    blurb: 'Caso com provas para pedir desconto, reembolso ou tarifa menor.',
    params: [T('com_quem', 'Com quem', 'ex.: operadora de internet'), AREA('situacao', 'Situação', '')],
    task: 'Monte um caso para negociar com {com_quem}. Situação: {situacao}.',
    steps: ['Preços da concorrência com links', 'Argumentos em ordem de força', 'Mensagem de abertura', 'O que aceitar e o limite'],
    skills: ['negotiation-case'] },

  // ---------- Dados
  { id: 'limpar-planilha', name: 'Limpar planilha', emoji: '🧹', category: 'Dados', to: 'engineer',
    blurb: 'Tira duplicados, padroniza colunas e aponta o que está estranho.',
    params: [FILE('arquivo', 'Planilha (CSV/XLSX)')],
    task: 'Limpe a planilha {arquivo}: duplicados, datas e números padronizados, espaços, colunas vazias. Salve a versão limpa ao lado.',
    steps: ['Perfil dos dados antes', 'Limpeza com script (nunca à mão)', 'Relatório do que mudou', 'Nunca apague o original'],
    skills: [] },
  { id: 'explicar-dados', name: 'Explicar dados', emoji: '📊', category: 'Dados', to: 'engineer',
    blurb: 'O que os números dizem: tendências, destaques e um gráfico.',
    params: [FILE('arquivo', 'Arquivo de dados'), T('pergunta', 'Pergunta', 'ex.: o que mais vendeu no trimestre?')],
    task: 'Analise {arquivo} e responda: {pergunta}. Gere um gráfico em HTML.',
    steps: ['Calcule com script', 'Resposta direta primeiro', '3 destaques', 'Gráfico salvo em grafico.html'],
    skills: ['concept-diagrams'] },

  // ---------- Código
  { id: 'corrigir-bug', name: 'Corrigir um bug', emoji: '🐞', category: 'Código', to: 'engineer',
    blurb: 'Reproduz, acha a causa raiz, corrige e prova com teste.',
    params: [AREA('bug', 'O que está acontecendo', 'Erro, passos para reproduzir…'), T('onde', 'Onde (arquivo/repositório)', '', { required: false })],
    task: 'Corrija este bug: {bug}. Onde: {onde}.',
    steps: ['Reproduza antes de mexer', 'Ache a causa raiz', 'Escreva um teste que falha', 'Corrija e mostre o teste passando'],
    skills: ['systematic-debugging', 'test-driven-development'] },
  { id: 'revisar-codigo', name: 'Revisar código', emoji: '🧐', category: 'Código', to: 'reviewer',
    blurb: 'Revisão com bugs reais primeiro, depois clareza e segurança.',
    params: [FILE('arquivo', 'Arquivo ou pasta')],
    task: 'Revise o código em {arquivo}.',
    steps: ['Bugs de verdade primeiro, com linha', 'Segurança', 'Clareza e simplificação', 'Nada de achismo: cite o trecho'],
    skills: ['code-review', 'security-sweep'] },
  { id: 'nova-funcao', name: 'Construir uma função', emoji: '🛠️', category: 'Código', to: 'engineer',
    blurb: 'Da ideia ao código testado: especificação curta, plano e implementação.',
    params: [AREA('ideia', 'O que construir', ''), T('stack', 'Tecnologia', 'ex.: FastAPI + PostgreSQL', { required: false })],
    task: 'Construa: {ideia}. Tecnologia: {stack}.',
    steps: ['Especificação mínima', 'Plano curto', 'Testes primeiro', 'Implementação', 'Como rodar'],
    skills: ['spec-drafting', 'plan', 'test-driven-development'] },
  { id: 'seguranca-app', name: 'Checar segurança do app', emoji: '🛡️', category: 'Código', to: 'engineer',
    blurb: 'Procura chaves expostas, rotas sem proteção e regras de banco abertas.',
    params: [T('onde', 'Pasta ou repositório', '')],
    task: 'Faça uma varredura de segurança em {onde}.',
    steps: ['Segredos no código e no front', 'Rotas sem autenticação', 'Regras de banco', 'Cada achado com prova e correção'],
    skills: ['exposed-secrets-audit', 'security-sweep'] },

  // ---------- Rotina
  { id: 'revisao-semanal', name: 'Revisão da semana', emoji: '🗓️', category: 'Rotina', to: 'captain', cadence: '0 17 * * 5',
    blurb: 'O que a tripulação fez, o que ficou pendente e o foco da próxima semana.',
    params: [T('foco', 'Seu foco atual', 'ex.: lançar a loja', { required: false })],
    task: 'Faça a revisão da semana: o que foi entregue (veja relatórios e o caderno), o que ficou pendente e 3 prioridades para a próxima semana. Meu foco: {foco}.',
    steps: ['Consulte o caderno (notebook_read) e os relatórios', 'Entregas da semana', 'Pendências com dono', '3 prioridades'],
    skills: ['commitment-tracking'] },
  { id: 'preparar-reuniao', name: 'Preparar reunião', emoji: '👥', category: 'Rotina', to: 'research',
    blurb: 'Pauta, contexto das pessoas/empresa e perguntas para fazer.',
    params: [T('reuniao', 'Reunião com quem / sobre o quê', ''), T('objetivo', 'Seu objetivo', '')],
    task: 'Prepare minha reunião: {reuniao}. Meu objetivo: {objetivo}.',
    steps: ['Contexto público da empresa/tema', 'Pauta de 30 minutos', '5 perguntas certeiras', 'Possíveis objeções e respostas'],
    skills: ['web-research'] },
  { id: 'decisao', name: 'Ajudar a decidir', emoji: '🧠', category: 'Rotina', to: 'captain',
    blurb: 'Um problema, três opções com prós e contras e uma recomendação.',
    params: [AREA('decisao', 'Decisão', 'O que você precisa decidir?')],
    task: 'Me ajude a decidir: {decisao}',
    steps: ['Problema em uma frase', 'Três opções reais', 'Prós, contras e riscos', 'Uma recomendação clara'],
    skills: ['decision-1-3-1'] }
];

const ROLE_RE = { research: /pesquis|research/, writer: /redat|escrit|writer/, reviewer: /revis|review/, engineer: /engenh|dev|program|engineer/ };

function fill(template, values) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (_, k) => {
    const v = values && values[k] != null ? String(values[k]).trim() : '';
    return v || '(não informado)';
  });
}

function paramsFromText(text) {
  const keys = [...new Set((String(text).match(/\{([a-z0-9_]+)\}/gi) || []).map(x => x.slice(1, -1)))].slice(0, 8);
  return keys.map(k => ({ key: k, label: k.replace(/_/g, ' '), placeholder: '', type: 'text', required: true }));
}

function makeRecipes(deps) {
  const { db } = deps;
  const raw = db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT DEFAULT '⭐', category TEXT DEFAULT 'Minhas', blurb TEXT DEFAULT '',
    task TEXT NOT NULL, steps TEXT DEFAULT '[]', skills TEXT DEFAULT '[]', to_agent TEXT DEFAULT 'captain', cadence TEXT DEFAULT '', created_at TEXT)`);

  const custom = () => raw.prepare('SELECT * FROM recipes ORDER BY created_at').all().map(r => ({
    id: r.id, name: r.name, emoji: r.emoji, category: r.category || 'Minhas', blurb: r.blurb, task: r.task,
    steps: JSON.parse(r.steps || '[]'), skills: JSON.parse(r.skills || '[]'), to: r.to_agent || 'captain', cadence: r.cadence || '',
    params: paramsFromText(r.task), custom: true
  }));
  const all = () => CATALOG.concat(custom());
  const get = (id) => all().find(r => r.id === id) || null;

  // quem recebe: um id de tripulante, "captain" ou uma função
  function target(to) {
    const agents = db.listAgents();
    const byId = agents.find(a => a.id === to);
    if (byId) return byId;
    const cap = agents.find(a => a.captain);
    const re = ROLE_RE[to];
    if (re) {
      const hit = agents.find(a => re.test(String(a.name).toLowerCase())) || agents.find(a => re.test(String(a.role).toLowerCase()));
      if (hit) return hit;
    }
    return cap || agents[0] || null;
  }

  function compose(r, values) {
    for (const p of r.params || []) {
      const v = values && values[p.key];
      if (p.required && !(v != null && String(v).trim())) throw new Error('preencha: ' + p.label);
      if (v != null && String(v).length > 8000) throw new Error('texto grande demais em ' + p.label);
    }
    const parts = ['[Receita: ' + r.emoji + ' ' + r.name + ']', fill(r.task, values)];
    if (r.steps && r.steps.length) parts.push('Passo a passo:\n' + r.steps.map((s, i) => (i + 1) + '. ' + fill(s, values)).join('\n'));
    if (r.skills && r.skills.length) parts.push('Habilidades úteis (leia com skill_view antes de começar): ' + r.skills.join(', ') + '.');
    parts.push('Ao terminar, entregue o resultado de forma clara; se gerar arquivo, diga o caminho.');
    return parts.join('\n\n');
  }

  function createCustom(b) {
    const name = String(b.name || '').trim().slice(0, 80);
    const task = String(b.task || '').trim().slice(0, 6000);
    if (!name || !task) throw new Error('dê um nome e escreva a tarefa (use {campo} para perguntar algo na hora)');
    const id = 'minha-' + Date.now().toString(36);
    const steps = (Array.isArray(b.steps) ? b.steps : String(b.steps || '').split('\n')).map(s => String(s).trim()).filter(Boolean).slice(0, 12);
    raw.prepare('INSERT INTO recipes (id, name, emoji, category, blurb, task, steps, skills, to_agent, cadence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, String(b.emoji || '⭐').slice(0, 8), 'Minhas', String(b.blurb || '').slice(0, 300), task, JSON.stringify(steps),
        JSON.stringify(Array.isArray(b.skills) ? b.skills.map(String).slice(0, 8) : []), String(b.to || 'captain').slice(0, 60), String(b.cadence || '').slice(0, 60), new Date().toISOString());
    return get(id);
  }
  function removeCustom(id) {
    const r = get(id);
    if (!r) throw new Error('receita não encontrada');
    if (!r.custom) throw new Error('as receitas do catálogo não podem ser apagadas');
    raw.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  }

  return { all, get, compose, target, createCustom, removeCustom };
}

module.exports = { makeRecipes, CATALOG, fill, paramsFromText };
