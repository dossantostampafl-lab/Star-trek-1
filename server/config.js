'use strict';
/* server/config.js — lê .env (nativo do Node 22) e monta a configuração de cada provedor. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv(file) {
  const f = file || path.join(ROOT, '.env');
  if (fs.existsSync(f) && typeof process.loadEnvFile === 'function') process.loadEnvFile(f);
}

function providerConfig(name, env) {
  env = env || process.env;
  switch (name) {
    case 'freellmapi':
      return {
        kind: 'openai',
        name: 'freellmapi',
        baseUrl: env.FREELLMAPI_BASE_URL || 'http://localhost:3001/v1',
        apiKey: env.FREELLMAPI_KEY || '',
        model: env.FREELLMAPI_MODEL || 'auto:smart'
      };
    case 'anthropic':
      return {
        kind: 'anthropic',
        name: 'anthropic',
        baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
        apiKey: env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
      };
    case 'openai':
      return {
        kind: 'openai',
        name: 'openai',
        baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: env.OPENAI_API_KEY || '',
        model: env.OPENAI_MODEL || 'gpt-4o-mini'
      };
    default:
      throw new Error('Provedor desconhecido: "' + name + '" (use freellmapi, anthropic ou openai)');
  }
}

function getConfig(env) {
  env = env || process.env;
  const provider = (env.PROVIDER || 'freellmapi').trim();
  const fallback = (env.FALLBACK_PROVIDER || '').trim();
  return {
    provider: providerConfig(provider, env),
    fallback: fallback ? providerConfig(fallback, env) : null,
    workspace: path.resolve(ROOT, env.WORKSPACE || './workspace'),
    dataDir: path.resolve(ROOT, env.DATA_DIR || './data'),
    maxSteps: Math.max(1, Number(env.MAX_STEPS) || 12),
    port: Number(env.PORT) || 8787,
    // Endereço de escuta. Padrão só local; em container use 0.0.0.0 (a porta não é publicada, só o proxy alcança).
    host: env.HOST || '127.0.0.1',
    shellImage: env.SHELL_IMAGE || 'alpine:3.20',
    shellNetwork: env.SHELL_NETWORK === 'bridge' ? 'bridge' : 'none',
    maxConcurrent: Math.max(1, Number(env.MAX_CONCURRENT) || 3),
    // Acesso pela internet (Oracle Cloud etc.): endereço público e senha de acesso
    publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    accessPassword: env.ACCESS_PASSWORD || ''
  };
}

module.exports = { loadEnv, getConfig, providerConfig, ROOT };
