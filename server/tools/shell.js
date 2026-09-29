'use strict';
/* server/tools/shell.js — terminal do agente, SEMPRE dentro de um container Docker descartável.
   - Só a pasta de trabalho do agente é montada (em /work). Nada mais da sua máquina fica visível.
   - Sem rede por padrão (SHELL_NETWORK=none), sem privilégios, com limite de memória, CPU e processos.
   - Tempo máximo por comando; ao estourar, o container é morto.
   - Sem Docker → a ferramenta não é registrada (o agente simplesmente não tem terminal).
   Por que não um filtro de comandos? Porque lista de comandos proibidos sempre dá para contornar
   (vimos isso no StarNet). O isolamento de verdade é o container. */
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');

const MAX_OUTPUT = 50 * 1024;
const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|freellmapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[0-9A-Za-z-]{10,})/g;

function redact(s) { return String(s).replace(SECRET_RE, '[segredo removido]'); }

function dockerAvailable(timeoutMs) {
  return new Promise(resolve => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: timeoutMs || 5000, windowsHide: true }, (err, out) => resolve(!err && !!String(out).trim()));
  });
}

// Executor real (Docker). Injetável para teste.
function dockerRunner(opts) {
  return function run({ command, workspace, timeoutMs, signal }) {
    return new Promise((resolve) => {
      const name = 'st1-' + crypto.randomBytes(6).toString('hex');
      const args = ['run', '--rm', '--name', name,
        '--network', opts.network || 'none',
        '--memory', opts.memory || '1g', '--cpus', String(opts.cpus || 1), '--pids-limit', '256',
        '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
        '--mount', 'type=bind,src=' + workspace + ',dst=/work', '-w', '/work',
        '-e', 'HOME=/work',
        // no Linux, roda com o mesmo usuário da estação: os arquivos criados continuam editáveis por ela
        ...(typeof process.getuid === 'function' ? ['--user', process.getuid() + ':' + process.getgid()] : []),
        opts.image || 'alpine:3.20', 'sh', '-c', command];
      const child = spawn('docker', args, { windowsHide: true });
      let out = '';
      let cut = false;
      const onData = (d) => { if (out.length < MAX_OUTPUT) out += d.toString(); else cut = true; };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      let killedBy = '';
      const kill = (why) => { killedBy = why; execFile('docker', ['kill', name], { windowsHide: true }, () => {}); };
      const timer = setTimeout(() => kill('tempo esgotado (' + Math.round(timeoutMs / 1000) + 's)'), timeoutMs);
      if (signal) signal.addEventListener('abort', () => kill('cancelado'), { once: true });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: 'falha ao iniciar o docker: ' + e.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output: out.slice(0, MAX_OUTPUT) + (cut ? '\n… (saída cortada em 50 KB)' : ''), killedBy });
      });
    });
  };
}

/* makeShellTool({ workspaceFor(ctx) → pasta, runner, timeoutMs, image }) */
function makeShellTool(deps) {
  const runner = deps.runner || dockerRunner({ image: deps.image, network: deps.network });
  const timeoutMs = deps.timeoutMs || 120000;
  return {
    name: 'shell',
    scope: 'execute',
    description: 'Roda um comando de terminal (sh) num container Linux isolado. Sua pasta de trabalho está em /work. ' +
      'Sem internet por padrão. Cada comando começa do zero (nada instalado persiste fora de /work). Pede permissão ao comandante.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Comando sh, ex.: "ls -la && cat notas.txt"' } }, required: ['command'] },
    async run(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('comando vazio');
      if (command.length > 8000) throw new Error('comando longo demais');
      const workspace = deps.workspaceFor(ctx);
      const r = await runner({ command, workspace, timeoutMs, signal: ctx.signal });
      const head = r.killedBy ? '[interrompido: ' + r.killedBy + ']\n' : '[código de saída ' + r.code + ']\n';
      return redact(head + (r.output || '(sem saída)'));
    }
  };
}

module.exports = { makeShellTool, dockerRunner, dockerAvailable, redact };
