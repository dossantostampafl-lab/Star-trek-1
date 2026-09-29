#!/usr/bin/env bash
# deploy/oracle/setup.sh — instala o Star Trek 1 numa VM Ubuntu da Oracle Cloud (ARM Ampere ou x86).
#
# Uso (dentro da VM, com o projeto em /opt/star-trek-1):
#   sudo bash deploy/oracle/setup.sh                  # tudo: Node, Docker, Caddy (HTTPS), FreeLLMAPI, serviço
#   sudo bash deploy/oracle/setup.sh --sem-freellmapi # se o FreeLLMAPI já roda em outro lugar
#   sudo DOMAIN=estacao.meudominio.com bash deploy/oracle/setup.sh   # usar seu domínio em vez do sslip.io
#   sudo bash deploy/oracle/setup.sh --painel-fllm    # abre o painel do FreeLLMAPI em https://fllm.SEU-IP.sslip.io
#                                                     # (com senha) — útil para configurar pelo tablet/celular.
#                                                     # Rode de novo sem a opção para fechar o painel.
#
# Pode rodar de novo quando quiser: ele pula o que já está feito e não sobrescreve a sua senha nem o .env.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="startrek"
STATE_DIR="/var/lib/startrek"
SERVICE="star-trek-1"
PORT="8787"
WITH_FLLM=1
FLLM_PANEL=0
for a in "$@"; do
  [ "$a" = "--sem-freellmapi" ] && WITH_FLLM=0
  [ "$a" = "--painel-fllm" ] && FLLM_PANEL=1
done

say()  { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Rode com sudo: sudo bash deploy/oracle/setup.sh"
grep -qi ubuntu /etc/os-release || warn "Testado em Ubuntu 22.04/24.04; outra distribuição pode precisar de ajustes."
[ -f "$APP_DIR/server/index.js" ] || die "Não achei o projeto em $APP_DIR"
LOGIN_USER="${SUDO_USER:-ubuntu}"
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- convivência com outros projetos
# A VM pode já rodar outro sistema (ex.: The Creation). Nada dele é alterado: checamos as portas antes.
say "Checando portas em uso"
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' | head -1; }
for p in 80 443; do
  o="$(port_owner "$p")"
  if [ -n "$o" ] && [ "$o" != "caddy" ]; then
    die "A porta $p já está em uso por '$o'. O HTTPS do Star Trek usa o Caddy nas portas 80/443.
   Se outro projeto usa $o, me avise: dá para colocar o Star Trek atrás do mesmo servidor."
  fi
done
o="$(port_owner "$PORT")"
if [ -n "$o" ] && [ "$o" != "node" ]; then die "A porta $PORT já está em uso por '$o'. Mude PORT no .env e rode de novo."; fi
if [ -n "$(port_owner 3001)" ] && [ ! -d "$(getent passwd "${SUDO_USER:-ubuntu}" | cut -d: -f6)/freellmapi" ]; then
  warn "A porta 3001 já está em uso por outro programa — o FreeLLMAPI não será instalado aqui."
  WITH_FLLM=0
fi
ok "portas livres (ou já do Star Trek/Caddy)"

# ---------------------------------------------------------------- pacotes
say "Pacotes do sistema"
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl iptables-persistent netfilter-persistent \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null
ok "básicos instalados"

# ---------------------------------------------------------------- Node 22
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if node_ok; then ok "Node $(node -v) já instalado"; else
  say "Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node 22.13+ não ficou disponível"
  ok "Node $(node -v)"
fi
NODE_BIN="$(command -v node)"

# ---------------------------------------------------------------- Docker
if command -v docker >/dev/null; then ok "Docker já instalado"; else
  say "Instalando Docker (terminal dos agentes em container)"
  curl -fsSL https://get.docker.com | sh >/dev/null
  ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ,)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------------------------------------------------------------- Caddy (HTTPS automático)
if command -v caddy >/dev/null; then ok "Caddy já instalado"; else
  say "Instalando Caddy (HTTPS automático)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  ok "Caddy instalado"
fi

# ---------------------------------------------------------------- firewall da VM
# As imagens Ubuntu da Oracle vêm com iptables bloqueando tudo menos SSH. Libera 80 e 443.
say "Firewall da VM (portas 80 e 443)"
for p in 80 443; do
  if iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then ok "porta $p já liberada"
  else iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$p" -j ACCEPT; ok "porta $p liberada"; fi
done
netfilter-persistent save >/dev/null 2>&1 || warn "não consegui salvar as regras (netfilter-persistent)"
warn "Lembre de liberar 80 e 443 também na Security List da VCN, no painel da Oracle (veja docs/ORACLE.md)."

# ---------------------------------------------------------------- usuário do serviço
say "Usuário do serviço"
if id "$APP_USER" >/dev/null 2>&1; then ok "usuário $APP_USER já existe"; else
  useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "usuário $APP_USER criado"
fi
usermod -aG docker "$APP_USER"
mkdir -p "$STATE_DIR/data" "$STATE_DIR/workspace"
chown -R "$APP_USER:$APP_USER" "$STATE_DIR"
chmod 750 "$STATE_DIR"
sudo -u "$APP_USER" test -r "$APP_DIR/server/index.js" || die "O usuário $APP_USER não consegue ler $APP_DIR. Coloque o projeto em /opt/star-trek-1 (veja docs/ORACLE.md)."
ok "dados em $STATE_DIR"

# ---------------------------------------------------------------- endereço público
say "Endereço público"
if [ -n "${DOMAIN:-}" ]; then
  ok "usando o domínio $DOMAIN (aponte o DNS dele para o IP desta VM)"
else
  IP="$(curl -fsS -4 --max-time 10 https://ifconfig.me || curl -fsS -4 --max-time 10 https://api.ipify.org || true)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Não descobri o IP público. Rode de novo com DOMAIN=seu.dominio"
  DOMAIN="startrek.${IP//./-}.sslip.io"
  ok "IP público $IP → $DOMAIN (sslip.io: domínio grátis que aponta para o seu IP)"
fi

# ---------------------------------------------------------------- .env
say "Configuração (.env)"
ENV_FILE="$APP_DIR/.env"
NEW_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then cp "$APP_DIR/.env.example" "$ENV_FILE"; ok ".env criado a partir do .env.example"; fi
set_env() {   # set_env CHAVE VALOR  (só troca a linha CHAVE=..., mantém o resto)
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then
    local esc; esc="$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')"
    sed -i "s|^${k}=.*|${k}=${esc}|" "$ENV_FILE"
  else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi
}
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_env PUBLIC_URL "https://$DOMAIN"
set_env DATA_DIR "$STATE_DIR/data"
set_env WORKSPACE "$STATE_DIR/workspace"
set_env PORT "$PORT"
[ -n "$(get_env FREELLMAPI_BASE_URL)" ] || set_env FREELLMAPI_BASE_URL "http://127.0.0.1:3001/v1"
if [ "$(get_env ACCESS_PASSWORD | wc -c)" -lt 13 ]; then
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  set_env ACCESS_PASSWORD "$NEW_PASSWORD"
  ok "senha de acesso gerada (aparece no fim)"
else ok "senha de acesso mantida"; fi
chown "$LOGIN_USER:$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
ok ".env pronto ($ENV_FILE)"

# ---------------------------------------------------------------- FreeLLMAPI
if [ "$WITH_FLLM" = 1 ]; then
  say "FreeLLMAPI (provedor grátis, só acessível dentro da VM)"
  usermod -aG docker "$LOGIN_USER"
  FLLM_HOME="$(getent passwd "$LOGIN_USER" | cut -d: -f6)/freellmapi"
  if [ -d "$FLLM_HOME" ]; then ok "já instalado em $FLLM_HOME"; else
    sudo -u "$LOGIN_USER" -H sg docker -c "curl -fsSL https://freellmapi.co/install.sh | bash" \
      || warn "o instalador do FreeLLMAPI falhou — veja docs/ORACLE.md para instalar manualmente"
  fi
  # Por padrão ele publica a porta 3001 para a rede. Aqui prendemos em 127.0.0.1: o acesso ao painel é por túnel SSH.
  COMPOSE="$(ls "$FLLM_HOME"/docker-compose.y*ml "$FLLM_HOME"/compose.y*ml 2>/dev/null | head -1 || true)"
  if [ -n "$COMPOSE" ]; then
    if grep -qE '"?(0\.0\.0\.0:)?3001:3001"?' "$COMPOSE" && ! grep -q '127.0.0.1:3001:3001' "$COMPOSE"; then
      sed -i -E 's/"?(0\.0\.0\.0:)?3001:3001"?/"127.0.0.1:3001:3001"/' "$COMPOSE"
      (cd "$FLLM_HOME" && docker compose up -d >/dev/null 2>&1) && ok "porta 3001 presa em 127.0.0.1"
    else ok "porta 3001 já restrita ou em outro formato — confira com: sudo ss -ltnp | grep 3001"; fi
  else warn "não achei o docker-compose do FreeLLMAPI em $FLLM_HOME"; fi
fi

# ---------------------------------------------------------------- imagem do terminal
say "Imagem do terminal dos agentes"
IMG="$(get_env SHELL_IMAGE)"; IMG="${IMG:-alpine:3.20}"
docker pull -q "$IMG" >/dev/null && ok "$IMG pronta" || warn "não baixei $IMG agora (será baixada no primeiro uso)"

# ---------------------------------------------------------------- serviço
say "Serviço systemd"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Star Trek 1 — estação de agentes de IA
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
SupplementaryGroups=docker
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok "estação no ar em 127.0.0.1:$PORT" \
  || { journalctl -u "$SERVICE" -n 30 --no-pager; die "a estação não subiu — veja o log acima"; }

# ---------------------------------------------------------------- Caddy
say "HTTPS (Caddy)"
SITE_FILE="/etc/caddy/star-trek-1.caddy"
MAIN="/etc/caddy/Caddyfile"
cat > "$SITE_FILE" <<CADDY
# Gerado por deploy/oracle/setup.sh — Star Trek 1
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		# eventos em tempo real (SSE) sem buffer
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
  # Painel do FreeLLMAPI pela internet, protegido por usuário/senha do Caddy (além do login do próprio FreeLLMAPI).
  PANEL_HASH="$(caddy hash-password --plaintext "$(get_env ACCESS_PASSWORD)")"
  cat >> "$SITE_FILE" <<CADDY

fllm.${DOMAIN#startrek.} {
	basic_auth {
		admin $PANEL_HASH
	}
	reverse_proxy 127.0.0.1:3001
	header -Server
}
CADDY
fi
# O Caddyfile principal só ganha uma linha "import". Se ele é do pacote (página padrão) ou nosso, é substituído;
# se tem configuração de outro projeto, é mantido — com backup — e só recebe o import.
BACKUP=""
if [ ! -f "$MAIN" ] || grep -q 'Gerado por deploy/oracle/setup.sh' "$MAIN" || ! grep -vE '^\s*(#|$)' "$MAIN" | grep -qvE '^\s*(:80|root \*|file_server|\{|\})'; then
  printf '# Gerado por deploy/oracle/setup.sh\nimport %s\n' "$SITE_FILE" > "$MAIN"
  ok "Caddyfile principal criado"
elif grep -qF "import $SITE_FILE" "$MAIN"; then
  ok "Caddyfile principal já importa o Star Trek (configuração de outros projetos preservada)"
else
  BACKUP="$MAIN.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$MAIN" "$BACKUP"
  printf '\n# Star Trek 1\nimport %s\n' "$SITE_FILE" >> "$MAIN"
  ok "Caddyfile de outro projeto preservado (backup em $BACKUP); só adicionei o import"
fi
if ! caddy validate --config "$MAIN" --adapter caddyfile >/dev/null 2>&1; then
  [ -n "$BACKUP" ] && cp "$BACKUP" "$MAIN" && warn "configuração anterior do Caddy restaurada"
  caddy validate --config "$MAIN" --adapter caddyfile 2>&1 | tail -5
  die "Caddyfile inválido — nada foi alterado no servidor web"
fi
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "Caddy servindo https://$DOMAIN (o certificado sai em até 1 minuto, se as portas estiverem abertas na Oracle)"

# ---------------------------------------------------------------- resumo
printf '\n\033[1;36m★ Star Trek 1 instalado\033[0m\n'
printf '  Endereço:  https://%s\n' "$DOMAIN"
if [ -n "$NEW_PASSWORD" ]; then printf '  Senha:     \033[1m%s\033[0m   (guarde; ela fica em %s)\n' "$NEW_PASSWORD" "$ENV_FILE"
else printf '  Senha:     a que já estava em %s (ACCESS_PASSWORD)\n' "$ENV_FILE"; fi
cat <<NEXT

  Próximos passos:
NEXT
if [ "$FLLM_PANEL" = 1 ]; then cat <<NEXT
  1. Abra o painel do FreeLLMAPI:  https://fllm.${DOMAIN#startrek.}
     usuário: admin   senha: a mesma senha de acesso da estação
     Crie a conta, adicione as chaves grátis dos provedores e copie a chave unificada (freellmapi-...)
     do topo da página Keys. Depois de configurar, feche o painel rodando o setup de novo sem --painel-fllm.
NEXT
else cat <<NEXT
  1. No seu PC, abra um túnel para o painel do FreeLLMAPI:
       ssh -i ~/.ssh/oracle_st1 -L 3001:127.0.0.1:3001 $LOGIN_USER@${IP:-$DOMAIN}
     e acesse http://localhost:3001 — crie a conta, adicione as chaves grátis dos provedores
     e copie a chave unificada (freellmapi-...) do topo do painel.
     (Sem PC? Rode de novo com --painel-fllm para abrir o painel no navegador do tablet.)
NEXT
fi
cat <<NEXT
  2. Na VM:  sudo nano $ENV_FILE   → cole em FREELLMAPI_KEY
  3. Reinicie:  sudo systemctl restart $SERVICE
  4. Teste:     cd $APP_DIR && node cli.js --check

  Logs:        journalctl -u $SERVICE -f
  Atualizar:   sudo bash deploy/oracle/update.sh
NEXT
