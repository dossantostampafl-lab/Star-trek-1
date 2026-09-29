#!/usr/bin/env bash
# deploy/oracle/setup-docker.sh — instala o Star Trek 1 numa VM que JÁ TEM outro projeto com Caddy em container
# (ex.: The Creation). Nada do outro projeto é reinstalado: o Star Trek e o FreeLLMAPI sobem como containers
# na mesma rede do Caddy existente, e o Caddyfile dele ganha só um bloco marcado (com backup).
#
# Uso (dentro da VM, com o projeto em /opt/star-trek-1):
#   sudo bash deploy/oracle/setup-docker.sh                 # instala / atualiza
#   sudo bash deploy/oracle/setup-docker.sh --painel-fllm   # também abre o painel do FreeLLMAPI (com senha)
#   sudo CADDY_CONTAINER=nome bash deploy/oracle/setup-docker.sh   # se houver mais de um Caddy
#
# Pode rodar de novo quando quiser: mantém senha, chaves e dados.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="/var/lib/startrek"
COMPOSE="$APP_DIR/deploy/docker/compose.yml"
DENV="$APP_DIR/deploy/docker/.env"
MARK_BEGIN="# >>> star-trek-1 (gerado por deploy/oracle/setup-docker.sh — não edite entre as marcas)"
MARK_END="# <<< star-trek-1"
FLLM_PANEL=0
for a in "$@"; do [ "$a" = "--painel-fllm" ] && FLLM_PANEL=1; done

say()  { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Rode com sudo: sudo bash deploy/oracle/setup-docker.sh"
command -v docker >/dev/null || die "Docker não encontrado. Para uma VM sem outro projeto, use deploy/oracle/setup.sh"
docker compose version >/dev/null 2>&1 || die "Falta o plugin 'docker compose'"
LOGIN_USER="${SUDO_USER:-ubuntu}"

# ---------------------------------------------------------------- Caddy existente
say "Procurando o Caddy do outro projeto"
CADDY_CT="${CADDY_CONTAINER:-}"
if [ -z "$CADDY_CT" ]; then
  mapfile -t found < <(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1}')
  [ "${#found[@]}" -eq 1 ] || die "Encontrei ${#found[@]} containers de Caddy (${found[*]:-nenhum}). Rode de novo com CADDY_CONTAINER=nome"
  CADDY_CT="${found[0]}"
fi
ok "container: $CADDY_CT"
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CT" | awk '{print $1}')"
[ -n "$NET" ] || die "Não descobri a rede Docker do $CADDY_CT"
ok "rede: $NET"
CF="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY_CT")"
if [ -z "$CF" ]; then
  DIR="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$CADDY_CT")"
  [ -n "$DIR" ] && CF="$DIR/Caddyfile"
fi
[ -n "$CF" ] && [ -f "$CF" ] || die "O Caddyfile do $CADDY_CT não está montado de um arquivo da VM — não dá para adicionar o Star Trek sem mexer na imagem dele. Me mande: sudo docker inspect $CADDY_CT"
ok "Caddyfile: $CF"
docker exec "$CADDY_CT" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || die "O Caddyfile atual já está inválido antes de qualquer mudança — nada foi alterado."

# ---------------------------------------------------------------- endereço
say "Endereço público"
if [ -n "${DOMAIN:-}" ]; then ok "domínio $DOMAIN"; BASE="${DOMAIN#startrek.}"
else
  IP="$(curl -fsS -4 --max-time 10 https://ifconfig.me || curl -fsS -4 --max-time 10 https://api.ipify.org || true)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Não descobri o IP público. Rode com DOMAIN=seu.dominio"
  BASE="${IP//./-}.sslip.io"
  DOMAIN="startrek.$BASE"
  ok "$DOMAIN"
fi

# ---------------------------------------------------------------- .env do Star Trek
say "Configuração"
ENV_FILE="$APP_DIR/.env"
NEW_PASSWORD=""
[ -f "$ENV_FILE" ] || { cp "$APP_DIR/.env.example" "$ENV_FILE"; ok ".env criado"; }
set_env() {
  local f="$1" k="$2" v="$3"
  if grep -q "^${k}=" "$f"; then
    local esc; esc="$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')"
    sed -i "s|^${k}=.*|${k}=${esc}|" "$f"
  else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}
get_env() { [ -f "$1" ] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true; }
set_env "$ENV_FILE" PUBLIC_URL "https://$DOMAIN"
set_env "$ENV_FILE" FREELLMAPI_BASE_URL "http://star-trek-freellmapi:3001/v1"
if [ "$(get_env "$ENV_FILE" ACCESS_PASSWORD | wc -c)" -lt 13 ]; then
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  set_env "$ENV_FILE" ACCESS_PASSWORD "$NEW_PASSWORD"
  ok "senha de acesso gerada (aparece no fim)"
else ok "senha de acesso mantida"; fi
chown "$LOGIN_USER:$LOGIN_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

touch "$DENV"
set_env "$DENV" PROXY_NETWORK "$NET"
[ -n "$(get_env "$DENV" FREELLMAPI_ENCRYPTION_KEY)" ] || set_env "$DENV" FREELLMAPI_ENCRYPTION_KEY "$(openssl rand -hex 32)"
chown "$LOGIN_USER:$LOGIN_USER" "$DENV"; chmod 600 "$DENV"
mkdir -p "$STATE_DIR/data" "$STATE_DIR/workspace"
ok "dados em $STATE_DIR"

# ---------------------------------------------------------------- containers
say "Construindo e subindo os containers (a primeira vez leva alguns minutos)"
docker compose -f "$COMPOSE" --env-file "$DENV" up -d --build
for _ in $(seq 1 60); do docker exec star-trek-1 wget -qO- http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break; sleep 2; done
docker exec star-trek-1 wget -qO- http://127.0.0.1:8787/api/health >/dev/null 2>&1 \
  || { docker logs --tail 40 star-trek-1; die "o Star Trek não subiu — veja o log acima"; }
ok "star-trek-1 no ar"
docker ps --format '{{.Names}}' | grep -qx star-trek-freellmapi && ok "star-trek-freellmapi no ar" || warn "FreeLLMAPI não está rodando: docker logs star-trek-freellmapi"

# ---------------------------------------------------------------- Caddy: adiciona o bloco, valida, recarrega
say "Ligando o endereço no Caddy do outro projeto"
BACKUP="$CF.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$CF" "$BACKUP"
TMP="$(mktemp)"
# remove um bloco antigo nosso (se houver) e acrescenta o novo
awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$CF" > "$TMP"
{
  echo ""
  echo "$MARK_BEGIN"
  cat <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy star-trek-1:8787 {
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Frame-Options "DENY"
		-Server
	}
}
CADDY
  if [ "$FLLM_PANEL" = 1 ]; then
    # Sem basic_auth: o painel do FreeLLMAPI usa o próprio cabeçalho Authorization (conta + código de configuração),
    # e uma senha do Caddy na frente conflita com ele. Feche o painel depois de configurar (rode sem --painel-fllm).
    cat <<CADDY

fllm.$BASE {
	reverse_proxy star-trek-freellmapi:3001
	header -Server
}
CADDY
  fi
  echo "$MARK_END"
} >> "$TMP"
# escreve no MESMO arquivo (mantém o inode: arquivos montados em container não enxergam arquivo substituído)
cat "$TMP" > "$CF"; rm -f "$TMP"
restore() { cat "$BACKUP" > "$CF"; warn "Caddyfile original restaurado"; }
if ! docker exec "$CADDY_CT" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  docker exec "$CADDY_CT" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5 || true
  restore; die "a configuração nova não passou na validação — o Caddy continua como estava"
fi
if docker exec "$CADDY_CT" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  ok "Caddy recarregado sem reiniciar (o outro projeto não caiu)"
else
  restore
  docker exec "$CADDY_CT" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  die "o Caddy não aceitou recarregar — voltei a configuração anterior. Me mande: sudo docker logs --tail 30 $CADDY_CT"
fi
ok "backup do Caddyfile: $BACKUP"

# ---------------------------------------------------------------- resumo
printf '\n\033[1;36m★ Star Trek 1 instalado ao lado de %s\033[0m\n' "$CADDY_CT"
printf '  Endereço:  https://%s   (o certificado sai em até 1 minuto)\n' "$DOMAIN"
if [ -n "$NEW_PASSWORD" ]; then printf '  Senha:     \033[1m%s\033[0m   (guarde; fica em %s)\n' "$NEW_PASSWORD" "$ENV_FILE"
else printf '  Senha:     a que já estava em %s (ACCESS_PASSWORD)\n' "$ENV_FILE"; fi
if [ "$FLLM_PANEL" = 1 ]; then
  printf '  Painel do FreeLLMAPI:  https://fllm.%s   (protegido pela conta do próprio FreeLLMAPI)\n' "$BASE"
fi
cat <<NEXT

  Próximos passos:
  1. No painel do FreeLLMAPI: crie a conta, cadastre as chaves grátis dos provedores e copie a
     chave unificada (freellmapi-...) do topo da página Keys.
     (Sem --painel-fllm? Rode de novo com essa opção para abrir o painel no navegador.)
  2. nano $ENV_FILE   → cole em FREELLMAPI_KEY=
  3. sudo docker compose -f $COMPOSE --env-file $DENV up -d
  4. Feche o painel quando terminar: rode este script de novo sem --painel-fllm

  Logs:       sudo docker logs -f star-trek-1
  Atualizar:  cd $APP_DIR && sudo git pull && sudo bash deploy/oracle/setup-docker.sh
  Se o outro projeto sobrescrever o Caddyfile dele, é só rodar este script de novo.
NEXT
