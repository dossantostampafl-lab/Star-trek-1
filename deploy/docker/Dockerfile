# Star Trek 1 em container. Os testes rodam no build: se falharem, a imagem nova não é criada
# e o container antigo continua no ar.
FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY . .
RUN node --test test/*.test.js > /tmp/tests.log 2>&1 || (tail -40 /tmp/tests.log; exit 1)
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "server/index.js"]
