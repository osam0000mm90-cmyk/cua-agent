import { spawn } from 'node:child_process';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const envPort = process.env.npm_config_port ?? process.env.DEMO_WEB_PORT ?? process.env.PORT;
const port = Number(envPort ?? (mode === 'dev' ? 3001 : 3001));
const nextCommand = process.platform === 'win32' ? 'next.cmd' : 'next';
const args = [mode, '--port', String(Number.isFinite(port) && port > 0 ? port : 3001)];

const child = spawn(nextCommand, args, {
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 0;
});
