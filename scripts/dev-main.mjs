import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

import { getToggleFlag, loadEnvFileFromRoot } from "./runtime-env.mjs";

const rootDir = process.cwd();
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

loadEnvFileFromRoot(rootDir);

function prefixStream(name, stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index = -1;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        process.stdout.write(`[${name}] ${line}\n`);
      }
    }
  });
  stream.on("end", () => {
    const line = buffer.replace(/\r$/, "");
    if (line.length > 0) {
      process.stdout.write(`[${name}] ${line}\n`);
    }
  });
}

function spawnStep(name, args) {
  const child = spawn(pnpmCommand, args, {
    cwd: rootDir,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  prefixStream(name, child.stdout);
  prefixStream(name, child.stderr);
  return child;
}

function hasTelegramToken() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

function finalizeOnFailure(failedChild, children, code, signal) {
  if (!signal && code === 0) {
    return;
  }

  for (const child of children) {
    if (child !== failedChild && child.pid) {
      child.kill("SIGTERM");
    }
  }

  process.exitCode = code ?? 1;
}

const children = [];
const runner = spawnStep("runner", ["--filter", "@cua-sample/runner", "dev"]);
children.push(runner);
runner.on("exit", (code, signal) => finalizeOnFailure(runner, children, code, signal));

if (getToggleFlag(process.env.ENABLE_WEB, false)) {
  const web = spawnStep("web", ["--filter", "@cua-sample/demo-web", "dev"]);
  children.push(web);
  web.on("exit", (code, signal) => finalizeOnFailure(web, children, code, signal));
} else {
  process.stdout.write("[web] ENABLE_WEB=false; the Next.js console is not started by pnpm dev.\n");
  process.stdout.write("[web] Run pnpm dev:web or set ENABLE_WEB=true to launch it alongside the runner.\n");
}

const telegramEnabled = getToggleFlag(process.env.ENABLE_TELEGRAM, hasTelegramToken());
if (telegramEnabled && hasTelegramToken()) {
  const bot = spawnStep("telegram", ["--filter", "@cua-sample/telegram-bot", "dev"]);
  children.push(bot);
  bot.on("exit", (code, signal) => finalizeOnFailure(bot, children, code, signal));
} else if (!telegramEnabled) {
  process.stdout.write("[telegram] ENABLE_TELEGRAM=false; the Telegram control bot is not started.\n");
} else {
  process.stdout.write("[telegram] TELEGRAM_BOT_TOKEN is not set, so the Telegram control bot is not started.\n");
  process.stdout.write("[telegram] Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS in .env to enable the bot.\n");
}

process.on("SIGINT", () => {
  for (const child of children) {
    if (child.pid) {
      child.kill("SIGTERM");
    }
  }
  process.exit(130);
});

process.on("SIGTERM", () => {
  for (const child of children) {
    if (child.pid) {
      child.kill("SIGTERM");
    }
  }
  process.exit(143);
});

await once(runner, "exit");
