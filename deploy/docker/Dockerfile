# Star Trek 1 em container. Os testes rodam no build: se falharem, a imagem nova não é criada
# e o container antigo continua no ar.
FROM node:22-alpine
# chromium + fonte: navegador dos tripulantes (ferramentas browser / browser_act)
RUN apk add --no-cache docker-cli poppler-utils unzip chromium ttf-freefont
WORKDIR /app
COPY . .
# o teste do navegador fica de fora do build (depende do ambiente de build); o navegador é conferido ao usar
RUN ST1_SKIP_BROWSER_TEST=1 node --test test/*.test.js > /tmp/tests.log 2>&1 || (tail -40 /tmp/tests.log; exit 1)
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CHROME_PATH=/usr/bin/chromium-browser
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "server/index.js"]
