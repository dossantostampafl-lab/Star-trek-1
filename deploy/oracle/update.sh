#!/usr/bin/env bash
# deploy/oracle/update.sh — atualiza o Star Trek 1 na VM: baixa o código novo do GitHub, testa e reinicia.
# Uso: sudo bash deploy/oracle/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGIN_USER="${SUDO_USER:-ubuntu}"
[ "$(id -u)" = 0 ] || { echo "Rode com sudo: sudo bash deploy/oracle/update.sh"; exit 1; }

cd "$APP_DIR"
echo "▶ Baixando a versão nova"
sudo -u "$LOGIN_USER" git pull --ff-only
echo "▶ Rodando os testes"
# shellcheck disable=SC2024  # o log é escrito pelo root de propósito
sudo -u "$LOGIN_USER" node --test test/*.test.js > /tmp/st1-tests.log 2>&1 || { tail -30 /tmp/st1-tests.log; echo "✗ Testes falharam — a estação NÃO foi reiniciada."; exit 1; }
echo "▶ Reiniciando"
systemctl restart star-trek-1
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && echo "✓ Estação atualizada e no ar." || { journalctl -u star-trek-1 -n 30 --no-pager; exit 1; }
