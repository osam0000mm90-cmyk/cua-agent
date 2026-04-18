import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  agentCapabilityManifestSchema,
  runDetailSchema,
  scenariosResponseSchema,
  startRunResponseSchema,
} from "@cua-sample/replay-schema";

type TelegramUpdate = {
  message?: TelegramMessage;
  update_id: number;
};

type TelegramMessage = {
  chat: { id: number; type: string };
  message_id: number;
  text?: string;
};

type BotState = {
  activeRunId?: string;
  defaultScenarioId: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
};

type RunnerScenario = {
  id: string;
  title: string;
  description: string;
  defaultMode: string;
  category: string;
};

type RunnerCapability = {
  category: string;
  description: string;
  enabled: boolean;
  name: string;
  notes: string[];
};

type RunnerRunResponse = {
  runId: string;
  status: "queued" | "running";
  eventStreamUrl: string;
  replayUrl: string;
};

function loadRepoEnvFile() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(moduleDir, "../../../.env");

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key]) {
      continue;
    }

    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}

loadRepoEnvFile();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required to start the Telegram control bot.");
}

const runnerBaseUrl = process.env.TELEGRAM_RUNNER_BASE_URL?.trim() || "http://127.0.0.1:4001";
const allowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean),
);
const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
const allowOpenAccess = (process.env.TELEGRAM_ALLOW_OPEN_ACCESS ?? "false").trim().toLowerCase() === "true";
const requireAllowlist =
  (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production" ||
  (process.env.TELEGRAM_REQUIRE_ALLOWLIST ?? "true").trim().toLowerCase() === "true";

if (requireAllowlist && allowedChatIds.size === 0 && !allowOpenAccess) {
  throw new Error(
    "TELEGRAM_ALLOWED_CHAT_IDS is required for production Telegram control. Set TELEGRAM_ALLOW_OPEN_ACCESS=true only for local development.",
  );
}

const defaultScenarioId = process.env.TELEGRAM_DEFAULT_SCENARIO_ID?.trim() || "desktop-control-console";
const maxHistoryMessages = Math.max(4, Number(process.env.TELEGRAM_MAX_HISTORY_MESSAGES ?? 12));
const pollTimeoutSec = Math.max(5, Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC ?? 30));
const pollSleepMs = Math.max(500, Number(process.env.TELEGRAM_POLL_SLEEP_MS ?? 1500));
const model = process.env.TELEGRAM_MODEL?.trim() || process.env.CUA_DEFAULT_MODEL?.trim() || "gpt-5.4";
const maxResponseTurns = Math.max(4, Number(process.env.TELEGRAM_MAX_RESPONSE_TURNS ?? 20));
const browserMode = (process.env.TELEGRAM_BROWSER_MODE?.trim() as
  | "headless"
  | "headful"
  | undefined) || "headless";
const sendEventSummaries = (process.env.TELEGRAM_SEND_EVENT_SUMMARIES ?? "true")
  .trim()
  .toLowerCase() !== "false";

const stateByChat = new Map<string, BotState>();
let scenarioCache: RunnerScenario[] | null = null;
let capabilityCache: RunnerCapability[] | null = null;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trimText(value: string, limit = 3200) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function getBotLink() {
  return botUsername ? `https://t.me/${botUsername}` : undefined;
}

function getState(chatId: string): BotState {
  const current = stateByChat.get(chatId);
  if (current) {
    return current;
  }

  const created: BotState = { defaultScenarioId, history: [] };
  stateByChat.set(chatId, created);
  return created;
}

async function apiFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${runnerBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "content-type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Runner API ${path} failed (${response.status}): ${body}`);
  }

  return response;
}

async function getScenarios(): Promise<RunnerScenario[]> {
  if (scenarioCache) {
    return scenarioCache;
  }

  const response = await apiFetch("/api/scenarios");
  scenarioCache = scenariosResponseSchema.parse(await response.json()) as RunnerScenario[];
  return scenarioCache;
}

async function getCapabilities(): Promise<RunnerCapability[]> {
  if (capabilityCache) {
    return capabilityCache;
  }

  const response = await apiFetch("/api/capabilities");
  const payload = agentCapabilityManifestSchema.parse(await response.json());
  capabilityCache = payload.capabilities as RunnerCapability[];
  return capabilityCache;
}

async function getRunDetail(runId: string) {
  const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}`);
  return runDetailSchema.parse(await response.json());
}

async function sendTelegram(method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Telegram ${method} failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<{ ok: boolean; result: unknown }>;
}

function splitTelegramText(text: string, limit = 3800) {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.6) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut < limit * 0.6) {
      cut = limit;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendMessage(chatId: string, text: string) {
  for (const chunk of splitTelegramText(text)) {
    await sendTelegram("sendMessage", {
      chat_id: Number(chatId),
      disable_web_page_preview: true,
      parse_mode: "HTML",
      text: chunk,
    });
  }
}


async function getUpdates(offset: number) {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  url.searchParams.set("timeout", String(pollTimeoutSec));
  url.searchParams.set("offset", String(offset));
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Telegram getUpdates failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
  return payload.result;
}

function isAllowedChat(chatId: number) {
  return allowedChatIds.size === 0 || allowedChatIds.has(String(chatId));
}

function remember(state: BotState, role: "user" | "assistant", text: string) {
  state.history.push({ role, text: trimText(text, 700) });
  const maxLength = maxHistoryMessages * 2;
  if (state.history.length > maxLength) {
    state.history.splice(0, state.history.length - maxLength);
  }
}

function buildPromptFromChat(messageText: string, state: BotState) {
  const history = state.history
    .slice(-maxHistoryMessages)
    .map((entry, index) => `${index + 1}. ${entry.role.toUpperCase()}: ${entry.text}`)
    .join("\n");

  return [
    "You are ChatGPT controlling a real desktop machine through a runner that exposes workspace, terminal, desktop, window, clipboard, and screen tools.",
    "Use the desktop and terminal tools as the primary execution surface. The browser page is only a lightweight control surface.",
    "Stay concise in visible chat updates and verify results before you report success.",
    "If the task is not complete, keep working instead of ending early.",
    "",
    `Default scenario: ${state.defaultScenarioId}`,
    `Model: ${model}`,
    `Browser mode: ${browserMode}`,
    `Max response turns: ${maxResponseTurns}`,
    "",
    history ? `Recent session context:\n${history}` : "Recent session context: none",
    "",
    `New user instruction: ${messageText}`,
  ].join("\n");
}

function formatScenarioList(scenarios: RunnerScenario[]) {
  return scenarios
    .map(
      (scenario) =>
        `• <b>${escapeHtml(scenario.id)}</b> — ${escapeHtml(scenario.title)} (${escapeHtml(scenario.category)})`,
    )
    .join("\n");
}

function formatCapabilityList(capabilities: RunnerCapability[]) {
  return capabilities
    .filter((capability) => capability.enabled)
    .map((capability) => `• <b>${escapeHtml(capability.name)}</b> — ${escapeHtml(capability.description)}`)
    .join("\n");
}

async function startRun(chatId: string, messageText: string) {
  const state = getState(chatId);
  const scenarios = await getScenarios();
  const scenario = scenarios.find((entry) => entry.id === state.defaultScenarioId) ?? scenarios[0];

  if (!scenario) {
    throw new Error("No scenarios are available from the runner.");
  }

  const payload = {
    browserMode,
    maxResponseTurns,
    mode: scenario.defaultMode,
    model,
    prompt: buildPromptFromChat(messageText, state),
    scenarioId: scenario.id,
    verificationEnabled: false,
  };

  const response = await apiFetch("/api/runs", {
    body: JSON.stringify(payload),
    method: "POST",
  });
  const start = startRunResponseSchema.parse(await response.json()) as RunnerRunResponse;
  state.activeRunId = start.runId;
  remember(state, "user", messageText);
  return { scenario, start };
}

async function watchRun(chatId: string, runId: string) {
  const state = getState(chatId);
  const response = await fetch(`${runnerBaseUrl}/api/runs/${encodeURIComponent(runId)}/events`);
  if (!response.ok || !response.body) {
    throw new Error(`Unable to subscribe to run ${runId}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastSent = "";
  let sawTerminalEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let index = -1;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!rawEvent) {
        continue;
      }

      const dataLine = rawEvent
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "));
      if (!dataLine) {
        continue;
      }

      try {
        const payload = JSON.parse(dataLine.slice(6)) as {
          detail?: string;
          message?: string;
          type?: string;
        };
        const summary = trimText(
          `${payload.message ?? payload.type ?? "event"}${payload.detail ? `: ${payload.detail}` : ""}`,
          900,
        );
        if (sendEventSummaries && summary !== lastSent) {
          lastSent = summary;
          await sendMessage(chatId, `🛰️ <b>${escapeHtml(state.activeRunId ?? runId)}</b>\n${escapeHtml(summary)}`);
        }
        if (payload.type === "run_completed" || payload.type === "run_failed" || payload.type === "run_cancelled") {
          sawTerminalEvent = true;
        }
      } catch {
        continue;
      }
    }

    if (sawTerminalEvent) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  const detail = await getRunDetail(runId).catch(() => null);
  state.activeRunId = undefined;
  if (detail) {
    await sendMessage(chatId, `Run <b>${escapeHtml(runId)}</b> finished with status <b>${escapeHtml(detail.run.status)}</b>.`);
    const notes = detail.run.summary?.notes?.slice(0, 5) ?? [];
    if (notes.length > 0) {
      await sendMessage(
        chatId,
        `✅ Summary\n${notes.map((note) => `• ${escapeHtml(note)}`).join("\n")}`,
      );
    }
  }
}

async function handleMessage(message: TelegramMessage) {
  const chatId = String(message.chat.id);
  if (!isAllowedChat(message.chat.id)) {
    return;
  }

  const state = getState(chatId);
  const text = (message.text ?? "").trim();
  if (!text) {
    return;
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    const link = getBotLink();
    await sendMessage(
      chatId,
      [
        "🤖 <b>Desktop Control Bot</b>",
        link ? `Bot link: ${escapeHtml(link)}` : undefined,
        "Type a normal message to start a task. The assistant will plan, execute, and report back in chat.",
        "Normal chat is the default mode. Slash commands are only shortcuts.",
        "Examples:",
        "• Open Notepad and draft a short note",
        "• Check the latest run and summarize errors",
        "• Use the desktop console to open Chrome and visit a page",
        "Shortcuts:",
        "/scenarios — list available scenarios",
        "/capabilities — show runner capabilities",
        "/use &lt;scenarioId&gt; — switch the default scenario",
        "/status — show the current run status",
        "/stop — stop the active run",
        "/reset — clear the chat session memory",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  if (text.startsWith("/reset")) {
    state.history = [];
    state.activeRunId = undefined;
    await sendMessage(chatId, "Session memory cleared.");
    return;
  }

  if (text.startsWith("/use ")) {
    const scenarioId = text.slice(5).trim();
    const scenarios = await getScenarios();
    const scenario = scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) {
      await sendMessage(chatId, `Unknown scenario: <b>${escapeHtml(scenarioId)}</b>. Use /scenarios to see valid ids.`);
      return;
    }
    state.defaultScenarioId = scenario.id;
    await sendMessage(chatId, `Default scenario set to <b>${escapeHtml(scenario.id)}</b> — ${escapeHtml(scenario.title)}`);
    return;
  }

  if (text.startsWith("/scenarios")) {
    const scenarios = await getScenarios();
    await sendMessage(chatId, `Available scenarios:\n${formatScenarioList(scenarios)}`);
    return;
  }

  if (text.startsWith("/capabilities")) {
    const capabilities = await getCapabilities();
    await sendMessage(chatId, `Runner capabilities:\n${formatCapabilityList(capabilities)}`);
    return;
  }

  if (text.startsWith("/status")) {
    const runId = state.activeRunId;
    if (!runId) {
      await sendMessage(chatId, "No active run in this chat session.");
      return;
    }
    const detail = await getRunDetail(runId);
    await sendMessage(
      chatId,
      [
        `Run <b>${escapeHtml(runId)}</b>`,
        `Status: <b>${escapeHtml(detail.run.status)}</b>`,
        `Scenario: ${escapeHtml(detail.scenario.id)}`,
        `Prompt: ${escapeHtml(trimText(detail.run.prompt, 220))}`,
      ].join("\n"),
    );
    return;
  }

  if (text.startsWith("/stop")) {
    const runId = state.activeRunId;
    if (!runId) {
      await sendMessage(chatId, "No active run to stop.");
      return;
    }
    await apiFetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: JSON.stringify({ reason: "Telegram operator requested stop." }),
    });
    state.activeRunId = undefined;
    await sendMessage(chatId, `Stop requested for run <b>${escapeHtml(runId)}</b>.`);
    return;
  }

  if (text.startsWith("/run ")) {
    const instruction = text.slice(5).trim();
    if (!instruction) {
      await sendMessage(chatId, "Provide a task after /run.");
      return;
    }
    if (state.activeRunId) {
      await sendMessage(chatId, `A run is already active: <b>${escapeHtml(state.activeRunId)}</b>. Use /stop or wait for it to finish.`);
      return;
    }
    remember(state, "user", instruction);
    const { scenario, start } = await startRun(chatId, instruction);
    await sendMessage(chatId, `▶️ Started <b>${escapeHtml(scenario.title)}</b> as run <b>${escapeHtml(start.runId)}</b>.`);
    void watchRun(chatId, start.runId).catch(async (error) => {
      await sendMessage(chatId, `Run watcher error: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    });
    return;
  }

  if (state.activeRunId) {
    await sendMessage(chatId, `A run is already active: <b>${escapeHtml(state.activeRunId)}</b>. Use /status or /stop.`);
    return;
  }

  remember(state, "user", text);
  const { scenario, start } = await startRun(chatId, text);
  await sendMessage(chatId, `▶️ Started <b>${escapeHtml(scenario.title)}</b> as run <b>${escapeHtml(start.runId)}</b>.`);
  void watchRun(chatId, start.runId).catch(async (error) => {
    await sendMessage(chatId, `Run watcher error: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
  });
}

async function waitForRunner() {
  for (;;) {
    try {
      const response = await fetch(`${runnerBaseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await delay(1000);
  }
}

async function main() {
  console.log(`[telegram] Control bot starting for ${runnerBaseUrl}`);
  if (botUsername) {
    console.log(`[telegram] Bot link: https://t.me/${botUsername}`);
  }
  await waitForRunner();
  console.log("[telegram] Runner is reachable.");

  let offset = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      console.error("[telegram] Polling error:", error);
      await delay(pollSleepMs);
    }
  }
}

await main();
