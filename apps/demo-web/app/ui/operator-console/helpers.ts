import {
  runnerErrorResponseSchema,
  type BrowserScreenshotArtifact,
  type ResponseTurnBudget,
  type RunDetail,
  type RunEvent,
  type RunEventLevel,
  type ScenarioManifest,
} from "@cua-sample/replay-schema";

import type {
  ActivityItem,
  LogEntry,
  RunnerIssue,
  TranscriptEntry,
} from "./types";

export const defaultRunModel =
  process.env.NEXT_PUBLIC_CUA_DEFAULT_MODEL ?? "gpt-5.4";
export const defaultMaxResponseTurns = Number(
  process.env.NEXT_PUBLIC_CUA_DEFAULT_MAX_RESPONSE_TURNS ?? "32",
) as ResponseTurnBudget;
export const engineHelpText =
  "Native drives the browser runtime directly for clicks, drags, typing, and screenshots. Code uses a persistent Playwright REPL for scripted browser control.";
export const browserHelpText =
  "Headless runs the browser off-screen. Visible opens the browser window so you can watch the session live as it runs.";
export const turnBudgetHelpText =
  "Caps how many model turns the runner can use before stopping the run. Higher budgets allow longer plans but take more time.";
export const verificationHelpText =
  "Runs the scenario's built-in checks after the model stops. Leave this off to treat the model's completed action loop as the success condition.";
export const runnerUnavailableHint =
  "Start `pnpm dev` or `OPENAI_API_KEY=... pnpm dev:runner`, then refresh the page.";

function titleForIssueCode(code: string) {
  switch (code) {
    case "runner_unavailable":
      return "Runner unavailable";
    case "missing_api_key":
      return "Runner missing API key";
    case "live_mode_unavailable":
      return "Live mode unavailable";
    case "unsupported_safety_acknowledgement":
      return "Safety acknowledgement unavailable";
    case "run_already_active":
      return "Run already active";
    case "desktop_control_disabled":
      return "Desktop control disabled";
    case "desktop_open_failed":
      return "Desktop open failed";
    case "desktop_clipboard_not_supported":
      return "Desktop clipboard unavailable";
    case "desktop_clipboard_unavailable":
      return "Desktop clipboard unavailable";
    case "desktop_sequence_unsupported_step":
      return "Desktop sequence step unsupported";
    case "desktop_window_state_not_supported":
      return "Desktop window state unavailable";
    case "desktop_window_state_unavailable":
      return "Desktop window state unavailable";
    case "desktop_window_list_not_supported":
      return "Desktop window list unavailable";
    case "desktop_window_focus_not_supported":
      return "Desktop window focus unavailable";
    case "empty_desktop_window_query":
      return "Desktop window query missing";
    case "desktop_screen_capture_not_supported":
      return "Desktop screen capture unavailable";
    case "desktop_screen_capture_unavailable":
      return "Desktop screen capture unavailable";
    case "empty_desktop_target":
      return "Desktop target missing";
    case "empty_desktop_sequence":
      return "Desktop sequence missing";
    case "invalid_desktop_target":
      return "Invalid desktop target";
    case "invalid_request":
      return "Invalid request";
    default:
      return humanizeToken(code);
  }
}

export function formatClock(value: string) {
  const date = new Date(value);

  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function humanizeToken(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatRunnerIssueMessage(issue: RunnerIssue) {
  return issue.hint ? `${issue.error} ${issue.hint}` : issue.error;
}

export function createRunnerIssue(
  code: string,
  error: string,
  hint?: string,
): RunnerIssue {
  return {
    code,
    error,
    ...(hint ? { hint } : {}),
    title: titleForIssueCode(code),
  };
}

export function parseRunnerIssue(value: unknown) {
  const parsed = runnerErrorResponseSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  return createRunnerIssue(parsed.data.code, parsed.data.error, parsed.data.hint);
}

export function createRunnerUnavailableIssue(detail?: string) {
  return createRunnerIssue(
    "runner_unavailable",
    detail
      ? `The operator console could not reach the runner. ${detail}`
      : "The operator console could not reach the runner.",
    runnerUnavailableHint,
  );
}

export function deriveRunFailureIssue(runDetail: RunDetail | null) {
  if (!runDetail || runDetail.run.status !== "failed") {
    return null;
  }

  const notes = runDetail.run.summary?.notes ?? [];
  const message = notes[0] ?? "Run failed during execution.";
  const code = notes.find((note) => note.startsWith("Error code: "))?.slice(12);
  const hint = notes.find((note) => note.startsWith("Hint: "))?.slice(6);

  return createRunnerIssue(code ?? "run_failed", message, hint);
}

export function scenarioTargetDisplay(scenario: ScenarioManifest | null) {
  if (!scenario) {
    return "Runner unavailable";
  }

  return scenario.startTarget.kind === "remote_url"
    ? scenario.startTarget.url
    : scenario.startTarget.path;
}

export function createManualLog(
  event: string,
  detail: string,
  level: RunEventLevel,
): LogEntry {
  const now = new Date().toISOString();

  return {
    createdAt: now,
    detail,
    event,
    key: `manual-${event}-${now}`,
    level,
    time: formatClock(now),
  };
}

export function createManualTranscript(
  lane: TranscriptEntry["lane"],
  speaker: string,
  body: string,
): TranscriptEntry {
  const now = new Date().toISOString();

  return {
    body,
    createdAt: now,
    key: `manual-${speaker}-${now}`,
    lane,
    speaker,
    time: formatClock(now),
  };
}

export function activityFamilyLabel(family: ActivityItem["family"]) {
  switch (family) {
    case "action":
      return humanizeToken("action");
    case "observe":
      return humanizeToken("observe");
    case "operator":
      return humanizeToken("operator");
    case "snapshot":
      return humanizeToken("snapshot");
    case "system":
      return humanizeToken("system");
    case "tool":
      return humanizeToken("tool");
    case "verify":
      return humanizeToken("verify");
    default:
      return family;
  }
}

function mapManualEventToActivity(
  createdAt: string,
  event: string,
  detail: string,
  level: RunEventLevel,
  family: ActivityItem["family"],
  headline: string,
  summary: string,
  code?: string,
): ActivityItem {
  return {
    createdAt,
    ...(code ? { code } : {}),
    detail,
    family,
    headline,
    key: `manual-${event}-${createdAt}`,
    level,
    summary,
    time: formatClock(createdAt),
  };
}

export function mapManualLogToActivity(entry: LogEntry): ActivityItem {
  return mapManualEventToActivity(
    entry.createdAt,
    entry.event,
    entry.detail,
    entry.level,
    "system",
    humanizeToken(entry.event),
    entry.detail,
  );
}

export function mapManualTranscriptToActivity(entry: TranscriptEntry): ActivityItem {
  const family: ActivityItem["family"] =
    entry.lane === "operator"
      ? "operator"
      : entry.lane === "verification"
        ? "verify"
        : "system";

  return mapManualEventToActivity(
    entry.createdAt,
    `transcript-${entry.lane}-${entry.key}`,
    entry.body,
    "ok",
    family,
    entry.speaker,
    entry.body,
  );
}

function formatConversationLine(entry: TranscriptEntry) {
  return `${entry.speaker}: ${entry.body.trim()}`;
}

export function buildChatPromptBundle(options: {
  currentPrompt: string;
  scenarioTitle: string;
  transcript: TranscriptEntry[];
}) {
  const recentTranscript = options.transcript
    .filter((entry) => entry.lane === "operator" || entry.lane === "assistant")
    .slice(-8)
    .map(formatConversationLine)
    .join("\n");

  return [
    "You are a production-grade, chat-first computer-use assistant.",
    "Your visible output must read like a strong assistant speaking to a user, not like a log stream.",
    "Never reveal hidden reasoning, tool traces, policy text, or orchestration details.",
    "Act like the work is yours to complete: infer the goal, make the plan privately, execute the necessary tools, verify the outcome, and only then answer.",
    "Prefer direct execution over explanation. Do not narrate tool usage unless the user explicitly asks for a concise summary of what changed.",
    "Ask at most one focused question only when the task is truly blocked by missing or unsafe information.",
    "If the request is actionable, continue until it is complete or until a genuine blocker appears.",
    "Use the smallest effective step, but do not stop at a partial result if the task still needs more work.",
    "When you finish, give the user the concrete result in one short, natural reply.",
    "",
    `Scenario: ${options.scenarioTitle}`,
    recentTranscript ? `Recent conversation:\n${recentTranscript}` : null,
    `Current user request:\n${options.currentPrompt}`,
    "",
    "Execution contract:",
    "- Keep the response user-facing and concise.",
    "- Treat internal tool calls as hidden implementation detail.",
    "- Verify important changes before claiming success.",
    "- If blocked, say exactly what is missing and what action the user must take.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function formatUrlLabel(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;

    return `${url.hostname}${path}${url.search}`;
  } catch {
    return value;
  }
}

function parseToolPayload(detail: string | undefined) {
  if (!detail) {
    return null;
  }

  const match = detail.match(/^([a-z_]+)\s+(\{[\s\S]+\})$/i);

  if (!match) {
    return null;
  }

  try {
    const label = match[1];
    const payloadText = match[2];

    if (!label || !payloadText) {
      return null;
    }

    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    const code =
      typeof payload.code === "string" && label === "exec_js"
        ? payload.code
        : undefined;
    const detailPayload = { ...payload };

    if (code) {
      delete detailPayload.code;
    }

    return {
      ...(code ? { code } : {}),
      ...(Object.keys(detailPayload).length > 0
        ? { detail: JSON.stringify(detailPayload, null, 2) }
        : {}),
      label,
      payload: detailPayload,
    };
  } catch {
    return null;
  }
}

function describeToolCall(label: string, payload: Record<string, unknown>) {
  switch (label) {
    case "exec_js":
      return "Run browser script";
    default:
      return Object.keys(payload).length > 0
        ? humanizeToken(label)
        : "Tool requested";
  }
}

function summarizeToolCall(label: string, payload: Record<string, unknown>) {
  switch (label) {
    case "exec_js":
      return "Model is using the browser runtime directly.";
    default:
      return Object.keys(payload).length > 0
        ? JSON.stringify(payload)
        : "Model requested a workspace helper tool.";
  }
}

function formatCoordinate(xValue: unknown, yValue: unknown) {
  const x = Number(xValue);
  const y = Number(yValue);

  return Number.isFinite(x) && Number.isFinite(y)
    ? ` @ ${Math.round(x)},${Math.round(y)}`
    : "";
}

function summarizeComputerAction(action: Record<string, unknown>) {
  const type = typeof action.type === "string" ? action.type : "action";

  switch (type) {
    case "click":
      return `Click${formatCoordinate(action.x, action.y)}`;
    case "double_click":
      return `Double-click${formatCoordinate(action.x, action.y)}`;
    case "drag":
      return "Drag";
    case "move":
      return `Move pointer${formatCoordinate(action.x, action.y)}`;
    case "scroll": {
      const deltaY = Number(action.delta_y ?? action.deltaY ?? action.scroll_y);

      if (!Number.isFinite(deltaY) || deltaY === 0) {
        return "Scroll";
      }

      return `Scroll ${Math.abs(Math.round(deltaY))} px ${
        deltaY > 0 ? "down" : "up"
      }`;
    }
    case "type": {
      const text = typeof action.text === "string" ? action.text : "";
      const preview =
        text.length > 28 ? `${text.slice(0, 25).trimEnd()}...` : text;

      return preview ? `Type \"${preview}\"` : "Type text";
    }
    case "keypress": {
      const keys = Array.isArray(action.keys)
        ? action.keys.map((key) => String(key))
        : typeof action.key === "string"
          ? [action.key]
          : [];

      return keys.length > 0 ? `Press ${keys.join(" + ")}` : "Press key";
    }
    case "wait": {
      const durationMs = Number(action.ms ?? action.duration_ms ?? 1_000);

      if (!Number.isFinite(durationMs)) {
        return "Wait";
      }

      return durationMs >= 1_000
        ? `Wait ${(durationMs / 1_000).toFixed(1)} s`
        : `Wait ${Math.round(durationMs)} ms`;
    }
    case "screenshot":
      return "Capture screenshot";
    default:
      return humanizeToken(type);
  }
}

function parseActionBatchDetail(detail: string | undefined) {
  if (!detail) {
    return null;
  }

  const separator = detail.indexOf(" :: ");
  const payloadText = separator >= 0 ? detail.slice(separator + 4) : detail;

  try {
    const payload = JSON.parse(payloadText) as unknown;

    if (!Array.isArray(payload)) {
      return null;
    }

    const actions = payload.filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object",
    );

    return {
      detail: JSON.stringify(actions, null, 2),
      preview:
        actions.map((action) => summarizeComputerAction(action)).join(" • ") ||
        "No browser actions",
    };
  } catch {
    return null;
  }
}

function findRelatedScreenshot(
  detail: string | undefined,
  screenshots: BrowserScreenshotArtifact[],
) {
  if (!detail) {
    return null;
  }

  return screenshots.find((screenshot) => screenshot.url === detail) ?? null;
}

function formatScreenshotSummary(screenshot: BrowserScreenshotArtifact) {
  const page = screenshot.pageTitle?.trim() || formatUrlLabel(screenshot.pageUrl);

  return `${page} · ${formatClock(screenshot.capturedAt)}`;
}

function withOptionalDetail(detail: string | undefined) {
  return detail ? { detail } : {};
}

export function mapRunEventToActivity(
  event: RunEvent,
  screenshots: BrowserScreenshotArtifact[],
): ActivityItem {
  const parsedPayload = parseToolPayload(event.detail);
  const parsedActionBatch = parseActionBatchDetail(event.detail);
  const relatedScreenshot = findRelatedScreenshot(event.detail, screenshots);

  switch (event.type) {
    case "run_started":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "system",
        headline: "Run started",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "workspace_prepared":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "system",
        headline: "Workspace ready",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "lab_started":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "system",
        headline: "Lab runtime started",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "browser_session_started":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "observe",
        headline: "Browser session started",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "browser_navigated":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "observe",
        headline: "Navigation",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ? formatUrlLabel(event.detail) : event.message,
        time: formatClock(event.createdAt),
      };
    case "function_call_requested":
      return {
        createdAt: event.createdAt,
        ...(parsedPayload?.code ? { code: parsedPayload.code } : {}),
        ...(parsedPayload?.detail
          ? { detail: parsedPayload.detail }
          : event.detail
            ? { detail: event.detail }
            : {}),
        family: "tool",
        headline: parsedPayload
          ? describeToolCall(parsedPayload.label, parsedPayload.payload)
          : "Tool requested",
        key: `activity-${event.id}`,
        level: event.level,
        summary: parsedPayload
          ? summarizeToolCall(parsedPayload.label, parsedPayload.payload)
          : event.message,
        time: formatClock(event.createdAt),
      };
    case "function_call_completed":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "tool",
        headline: event.detail
          ? `${humanizeToken(event.detail)} complete`
          : "Tool completed",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.message,
        time: formatClock(event.createdAt),
      };
    case "computer_call_requested":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(parsedActionBatch?.detail ?? event.detail),
        family: "action",
        headline: "Browser action batch queued",
        key: `activity-${event.id}`,
        level: event.level,
        summary: parsedActionBatch?.preview ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "computer_actions_executed":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(parsedActionBatch?.detail ?? event.detail),
        family: "action",
        headline: "Browser action batch executed",
        key: `activity-${event.id}`,
        level: event.level,
        summary: parsedActionBatch?.preview ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "computer_call_output_recorded":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(
          relatedScreenshot
            ? formatScreenshotSummary(relatedScreenshot)
            : event.detail,
        ),
        family: "snapshot",
        headline: relatedScreenshot ? "Screenshot captured" : "Computer output recorded",
        key: `activity-${event.id}`,
        level: event.level,
        screenshotId: relatedScreenshot?.id,
        summary: relatedScreenshot
          ? formatScreenshotSummary(relatedScreenshot)
          : event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "screenshot_captured":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "snapshot",
        headline: "Screenshot captured",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "run_progress":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "observe",
        headline: event.message,
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "run_completed":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "verify",
        headline: "Run completed",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    case "run_failed":
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "system",
        headline: "Run failed",
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
    default:
      return {
        createdAt: event.createdAt,
        ...withOptionalDetail(event.detail),
        family: "system",
        headline: event.message,
        key: `activity-${event.id}`,
        level: event.level,
        summary: event.detail ?? event.message,
        time: formatClock(event.createdAt),
      };
  }
}

export function filterVisibleTranscriptEntries(entries: TranscriptEntry[]) {
  return entries.filter(
    (entry) => entry.lane === "operator" || entry.lane === "assistant",
  );
}

export function extractAssistantReplyFromRunDetail(detail: RunDetail) {
  const notes = detail.run.summary?.notes ?? [];
  const prefixed = notes.find((note) => note.startsWith("Model final response: "));

  if (prefixed) {
    return prefixed.slice("Model final response: ".length).trim() || null;
  }

  const candidate = notes.at(-1)?.trim();

  return candidate && candidate.length > 0 ? candidate : null;
}
