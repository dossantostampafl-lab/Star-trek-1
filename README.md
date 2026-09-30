# ★ Star Trek 1

Estação de agentes de IA enxuta, inspirada no StarNet. Você recruta tripulantes (agentes), cada um na sua sala,
liga esteiras entre eles, agenda tarefas e acompanha tudo num mapa em pixel-art.

- **Custo zero por padrão:** usa o **FreeLLMAPI** rodando na sua máquina. Claude e outros provedores são opcionais.
- **Sem dependências:** só Node.js 22.13+. Não precisa de `npm install`. Banco SQLite embutido no Node.
- **Seguro por padrão:** terminal só em container Docker, com permissão a cada uso, checkpoint antes de cada mudança e
  nada de terminal em tarefas automáticas.

## Requisitos

- **Node.js 22.13 ou mais novo** — `node -v`
- **FreeLLMAPI** rodando em `http://localhost:3001` → https://github.com/tashfeenahmed/freellmapi
- Opcional: **Docker Desktop** (para o terminal dos agentes)

## Começar

```bash
cd star-trek-1
copy .env.example .env        # Linux/Mac: cp .env.example .env
```

Abra o `.env` e cole a chave do FreeLLMAPI (página **Keys** do painel, formato `freellmapi-...`) em `FREELLMAPI_KEY`.

```bash
npm run check     # testa a conexão com o FreeLLMAPI
npm start         # sobe a estação → abra http://127.0.0.1:8787
```

Também dá para usar só pelo terminal: `npm run chat` (conversa) ou `npm run ask -- "pergunta"`.

## Na internet (Oracle Cloud, grátis)

Para deixar a estação no ar 24 h numa VM Always Free da Oracle, com HTTPS, senha de acesso e o FreeLLMAPI
na mesma máquina, siga **[docs/ORACLE.md](docs/ORACLE.md)**. Resumo:

```bash
git clone https://github.com/dossantostampafl-lab/Star-trek-1.git /opt/star-trek-1
cd /opt/star-trek-1 && sudo bash deploy/oracle/setup.sh
```

## Tripulação pronta

Na primeira vez que a estação liga, ela já embarca a tripulação completa (desligue com `SEED_CREW=0`):

| Tripulante | Função |
| --- | --- |
| ★ **Capitão** | recebe seus pedidos, delega com `pass_work` e **recruta especialistas** novos quando precisa (`recruit`) |
| **Pesquisadora** | busca na web (`web_search`) e lê as páginas (`fetch_url`), sempre com fontes |
| **Redator** | transforma a pesquisa em texto claro |
| **Revisor** | confere, corrige e entrega a versão final |
| **Engenheira** | escreve e testa código (terminal em container) |

Esteiras: Capitão → todos (manual) · Pesquisadora → Redator → Revisor → Capitão (automáticas) · Engenheira → Revisor.
Agenda: dias úteis às 9h a Pesquisadora traz as novidades de agentes de IA. Numa estação que já tem tripulantes,
use o botão **Embarcar** (aba Tripulação) — ele só cria o que falta.

Fale só com o Capitão: o pedido percorre a esteira sozinho e o resumo final volta para ele.

## Visual e editor da estação

Cada tripulante tem um personagem animado (anda pela sala, vai até a mesa e digita quando está trabalhando)
e uma sala mobiliada de acordo com a função. Toque em **✏️ Editar estação** (canto do mapa) para:

- **trocar o personagem** do tripulante (17 opções);
- **pôr móveis** (48 peças: mesas, consoles, telões, plantas, sofás…) — toque na peça e depois arraste dentro da sala;
- **espelhar** ou **remover** a peça selecionada, ou voltar a sala ao **↺ padrão**;
- **mudar a sala de lugar** — escolha a sala e toque num contorno vazio (se já houver alguém lá, os dois trocam).

Tudo é salvo na hora. A arte vem do StarNet (MIT) — créditos em `web/assets/NOTICE.md`.

## Arquivos

Aba **Arquivos** (ou o 📎 no Canal): envie arquivos de até 25 MB. Eles vão para a **pasta compartilhada**
(`entrada/`), que todos os tripulantes leem com `shared_read_file`. PDF, DOCX, PPTX, XLSX e ODT são convertidos
em texto automaticamente. Na mesma aba você baixa o que os tripulantes produziram (pasta compartilhada ou de cada um).

## Conectores MCP (catálogo)

Aba **Conectores → Catálogo**: instale com um toque. Cada conector já é ligado nos tripulantes certos; os de
**leitura** ficam liberados sem perguntar, os outros pedem permissão a cada uso.

| Conector | Chave | Vai para |
| --- | --- | --- |
| Memória da tripulação | não | todos |
| Raciocínio em etapas | não | Capitão, Engenheira |
| Documentação de bibliotecas (Context7) | opcional | Engenheira, Pesquisadora |
| DeepWiki (repositórios GitHub) | não | Engenheira, Pesquisadora |
| Busca Tavily · Busca Brave · Firecrawl | sim (planos grátis) | Pesquisadora |
| GitHub · Notion · Supabase (só leitura) | token | Engenheira / Redator |

As chaves ficam no banco da estação (`data/`) e nunca são enviadas para a página.

## Usando a estação

| Aba | Para quê |
| --- | --- |
| **Tripulação** | Recrutar/editar agentes: nome, função, instruções, provedor/modelo, orçamento, terminal e conectores |
| **Canal** | Conversar com o tripulante (toque na sala dele no mapa). 🎙 fala em português; “Ler respostas” lê em voz alta. **Desfazer** volta a pasta dele para antes da última mudança |
| **Esteiras** | Ligar tripulantes. **Automática**: o resultado final segue sozinho para o próximo. **Manual**: o tripulante decide com a ferramenta `pass_work` |
| **Agenda** | Tarefas no horário do seu computador (cron: `minuto hora dia mês dia-semana`, ex.: `0 9 * * 1-5`) |
| **Conectores** | Conectores MCP (locais por comando, ou remotos por URL) e as permissões “sempre” dadas |
| **Registro** | Execuções, tokens e custo |

Cada tripulante tem a própria pasta em `workspace/<id>/` — é só lá que ele lê e escreve.

### Permissões

| Ação | Canal (você presente) | Agenda / esteira (automático) |
| --- | --- | --- |
| Ler arquivos, hora, páginas web públicas | livre | livre |
| Escrever arquivos (na pasta dele) | livre, com checkpoint | livre, com checkpoint |
| Terminal (container) | pergunta: uma vez / sessão / negar | **sempre negado** |
| Conector MCP | pergunta: uma vez / sessão / sempre / negar | só com “sempre” já dado |

Sem resposta em 5 minutos, ou sem a página aberta, a resposta é **negar**.

### Terminal

Precisa do Docker Desktop rodando. Cada comando roda num container descartável (`alpine:3.20` por padrão) que só enxerga
a pasta do tripulante (em `/work`), **sem internet** (`SHELL_NETWORK=none`), sem privilégios e com limite de memória,
CPU e tempo. Para usar outra imagem (ex.: com Python), mude `SHELL_IMAGE` no `.env`, por exemplo `python:3.12-alpine`.

### Conectores MCP — exemplo

Aba **Conectores** → Nome `arquivos`, Tipo *Local*, Comando `npx`,
Argumentos `-y @modelcontextprotocol/server-filesystem C:\Users\voce\Documentos\notas`.
Depois, em **Tripulação → Editar**, marque o conector no tripulante.

### Provedores e custo

No `.env` (padrão da estação) ou por tripulante (na ficha dele):

- `freellmapi` — padrão, grátis. `FREELLMAPI_MODEL`: `auto`, `auto:fast`, `auto:smart` (padrão), um perfil ou um id de modelo.
- `anthropic` — Claude (pago), com `ANTHROPIC_API_KEY`.
- `openai` — qualquer endpoint compatível com OpenAI (Ollama, OpenRouter, Groq…).
- `FALLBACK_PROVIDER` — se o principal falhar antes de começar a responder, tenta este.

O **orçamento** do tripulante (US$) interrompe a execução quando o gasto acumulado chega ao limite. O custo é calculado
por uma tabela de referência em `server/cost.js`; FreeLLMAPI e Ollama contam como zero.

## Segurança da estação

A estação escuta só em `127.0.0.1`. Toda rota da API exige um token gerado a cada inicialização (injetado na página),
com checagem de Host e Origem — um site malicioso aberto no seu navegador não consegue comandar os agentes.
Se reiniciar a estação, recarregue a página.

Quando `PUBLIC_URL` está definida (servidor na internet), a estação também exige **login com senha**
(`ACCESS_PASSWORD`, mínimo 12 caracteres), com cookie seguro de 30 dias e bloqueio após 5 tentativas erradas.

## Estrutura

```
cli.js                 linha de comando (chat, ask, check)
server/
  index.js             API HTTP + eventos (SSE) + página
  station.js           tripulação: filas, execuções, esteiras, pass_work, orçamento
  agent.js / loop.js   o agente e o loop de ferramentas
  providers/           FreeLLMAPI/OpenAI-compatível, Anthropic, retentativa + fallback
  tools/               arquivos (cela), hora, páginas web, terminal (Docker)
  permissions.js       quem pode o quê
  checkpoint.js        fotos da pasta antes de cada mudança
  cost.js              custo por modelo
  cron.js              agendamento (sem dependências)
  mcp.js               cliente MCP (stdio e HTTP)
  db.js                SQLite (node:sqlite)
  decor.js             personagens e móveis de cada sala (catálogo, validação, visual padrão)
  auth.js              login por senha (acesso pela internet)
deploy/oracle/         instalação e atualização na Oracle Cloud
docs/ORACLE.md         guia passo a passo da Oracle
web/
  index.html, style.css, app.js   painel
  station.js           mapa da estação: personagens animados, móveis, esteiras e o editor
  assets/              personagens e móveis em pixel-art (StarNet, MIT — ver NOTICE.md)
  voice.js             voz do navegador (pt-BR)
test/                  testes com provedores e MCP simulados — npm test
```

## Limites conhecidos

- Voz: o reconhecimento funciona no Chrome e no Edge (não no Firefox). A leitura em voz alta funciona em todos.
- O terminal não guarda nada instalado entre comandos (só o que estiver em `/work`).
- O FreeLLMAPI é para uso pessoal: sem modelos de ponta, latência variável e cotas diárias. Não envie dados sensíveis por ele.
- “Star Trek” é marca registrada da Paramount — ok para uso pessoal; troque o nome se for publicar.
