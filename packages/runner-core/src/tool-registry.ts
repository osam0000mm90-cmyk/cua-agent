import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { captureDesktopContextSnapshot, captureDesktopScreen, clickDesktopPoint, describeDesktopControlBackend, dragDesktopPath, focusDesktopWindow, getDesktopWindowState, listDesktopWindows, moveDesktopPointer, pressDesktopKeys, readDesktopClipboardText, runDesktopActionSequence, scrollDesktopWheel, typeDesktopText, writeDesktopClipboardText } from "./desktop-control.js";
import { RunnerCoreError } from "./errors.js";

const execFileAsync = promisify(execFile);

export type AgentToolContext = {
  allowDangerousCommands?: boolean;
  signal: AbortSignal;
  workspacePath: string;
};

export type ToolOutput =
  | {
      text: string;
      type: "input_text";
    }
  | {
      detail: "original";
      image_url: string;
      type: "input_image";
    };

type ToolDefinition = Record<string, unknown>;

type DirectoryEntry = {
  kind: "directory" | "file";
  name: string;
  path: string;
  size?: number;
};

type WorkspaceSearchMatch = {
  line: number;
  snippet: string;
};

const defaultListLimit = 200;
const defaultSearchLimit = 20;
const defaultReadLimit = 12_000;
const defaultTerminalTimeoutMs = 30_000;
const blockedCommandPattern = /\b(?:rm\s+-rf|rmdir\s+\/s(?:\s+\/q)?|del\s+(?:\/f\s+)?\/s|del\s+\/f\s+\/q|remove-item\b.*-recurse\b.*-force\b|remove-item\b.*-force\b.*-recurse\b|format\s+|shutdown\s+|reboot\s+|poweroff\b|mkfs\b|diskpart\b|reg\s+delete\b|dd\s+if=|wipefs\b)\b/i;


const blockedCommandDescriptions = [
  "rm -rf / style recursive deletion",
  "rmdir /s recursive deletion",
  "del /s destructive delete",
  "format disk operations",
  "shutdown / reboot / poweroff commands",
  "mkfs filesystem formatting",
  "diskpart disk manipulation",
  "registry deletion",
];

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function ensureWithinWorkspace(workspacePath: string, inputPath = ".") {
  const raw = inputPath.trim() || ".";
  const normalized = raw.replace(/^[\\/]+/, "");
  const absolute = resolve(workspacePath, normalized);
  const root = resolve(workspacePath);
  const rel = relative(root, absolute);

  if (isAbsolute(normalized) || rel.startsWith("..")) {
    throw new RunnerCoreError(`Path escapes the workspace root: ${inputPath}`, {
      code: "workspace_path_escape",
      hint: "Only paths inside the run workspace are allowed.",
      statusCode: 400,
    });
  }

  return absolute;
}

async function listWorkspaceEntries(
  workspacePath: string,
  inputPath = ".",
  depth = 2,
  maxEntries = defaultListLimit,
): Promise<DirectoryEntry[]> {
  const rootPath = ensureWithinWorkspace(workspacePath, inputPath);
  const result: DirectoryEntry[] = [];
  const rootResolved = resolve(workspacePath);

  async function walk(currentPath: string, currentDepth: number) {
    if (result.length >= maxEntries || currentDepth < 0) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (result.length >= maxEntries) {
        break;
      }

      const entryPath = join(currentPath, entry.name);
      const relativePath = relative(rootResolved, entryPath) || entry.name;

      if (entry.isDirectory()) {
        result.push({ kind: "directory", name: entry.name, path: relativePath });

        if (
          currentDepth > 0 &&
          !["node_modules", ".git", ".next", "dist", "coverage"].includes(entry.name)
        ) {
          await walk(entryPath, currentDepth - 1);
        }
        continue;
      }

      const fileStats = await stat(entryPath).catch(() => null);
      result.push({
        kind: "file",
        name: entry.name,
        path: relativePath,
        ...(fileStats ? { size: fileStats.size } : {}),
      });
    }
  }

  await walk(rootPath, depth);
  return result;
}

async function readWorkspaceFile(workspacePath: string, inputPath: string) {
  const absolutePath = ensureWithinWorkspace(workspacePath, inputPath);
  const payload = await readFile(absolutePath, "utf8");

  return {
    path: relative(resolve(workspacePath), absolutePath),
    text: payload.slice(0, defaultReadLimit),
    truncated: payload.length > defaultReadLimit,
  };
}

async function writeWorkspaceFile(
  workspacePath: string,
  inputPath: string,
  content: string,
) {
  const absolutePath = ensureWithinWorkspace(workspacePath, inputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");

  return {
    bytesWritten: Buffer.byteLength(content, "utf8"),
    path: relative(resolve(workspacePath), absolutePath),
  };
}

async function searchWorkspaceText(
  workspacePath: string,
  query: string,
  inputPath = ".",
  maxMatches = defaultSearchLimit,
) {
  const absolutePath = ensureWithinWorkspace(workspacePath, inputPath);
  const needle = query.trim();
  const matches: Array<{ path: string; snippets: WorkspaceSearchMatch[] }> = [];

  if (!needle) {
    return matches;
  }

  async function walk(currentPath: string) {
    if (matches.length >= maxMatches) {
      return;
    }

    const fileStats = await stat(currentPath).catch(() => null);
    if (!fileStats) {
      return;
    }

    if (fileStats.isDirectory()) {
      const dirName = currentPath.split(/[\/]/).pop() ?? "";

      if (["node_modules", ".git", ".next", "dist", "coverage"].includes(dirName)) {
        return;
      }

      const entries = await readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxMatches) {
          break;
        }
        await walk(join(currentPath, entry.name));
      }
      return;
    }

    if (fileStats.size > 250_000) {
      return;
    }

    const text = await readFile(currentPath, "utf8").catch(() => "");
    if (!text.includes(needle)) {
      return;
    }

    const snippets = text
      .split(/\r?\n/)
      .map((line, index) => ({ line: index + 1, snippet: line }))
      .filter(({ snippet }) => snippet.includes(needle))
      .slice(0, 10);

    matches.push({
      path: relative(resolve(workspacePath), currentPath),
      snippets,
    });
  }

  await walk(absolutePath);
  return matches;
}

async function runTerminalCommand(
  workspacePath: string,
  command: string,
  timeoutMs = defaultTerminalTimeoutMs,
  allowDangerousCommands = false,
  signal?: AbortSignal,
) {
  const trimmed = command.trim();

  if (!trimmed) {
    throw new RunnerCoreError("Terminal command cannot be empty.", {
      code: "empty_terminal_command",
      hint: "Provide a shell command to execute inside the run workspace.",
      statusCode: 400,
    });
  }

  if (!allowDangerousCommands && blockedCommandPattern.test(trimmed)) {
    throw new RunnerCoreError(
      "The requested terminal command matches a blocked destructive pattern.",
      {
        code: "dangerous_terminal_command",
        hint:
          "Use a safer command or set CUA_ALLOW_DANGEROUS_COMMANDS=true if you understand the risk.",
        statusCode: 400,
      },
    );
  }

  const startedAt = Date.now();
  const isWindows = process.platform === "win32";
  const commandFile = isWindows ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh";
  const commandArgs = isWindows ? ["/d", "/s", "/c", trimmed] : ["-lc", trimmed];

  try {
    const { stdout, stderr } = await execFileAsync(commandFile, commandArgs, {
      cwd: workspacePath,
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      signal,
    });

    return {
      command: trimmed,
      cwd: workspacePath,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stderr: String(stderr ?? "").slice(0, 8_000),
      stdout: String(stdout ?? "").slice(0, 16_000),
      success: true,
      timedOut: false,
    };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stderr?: string;
      stdout?: string;
      killed?: boolean;
      signal?: string;
    };

    return {
      command: trimmed,
      cwd: workspacePath,
      durationMs: Date.now() - startedAt,
      exitCode: typeof failure.code === "number" ? failure.code : -1,
      signal: failure.signal,
      stderr: String(failure.stderr ?? "").slice(0, 8_000),
      stdout: String(failure.stdout ?? "").slice(0, 16_000),
      success: false,
      timedOut: failure.killed ?? false,
    };
  }
}

async function speakText(text: string) {
  const payload = text.trim();

  if (!payload) {
    return { spoken: false, text: "" };
  }

  if (process.platform === "darwin") {
    await execFileAsync("say", [payload]).catch(() => undefined);
    return { spoken: true, text: payload, transport: "say" };
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Speech;",
      "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      `$speaker.Speak(${JSON.stringify(payload)});`,
    ].join(" ");

    await execFileAsync("powershell", ["-NoProfile", "-Command", script]).catch(() => undefined);
    return { spoken: true, text: payload, transport: "powershell-speech" };
  }

  await execFileAsync("sh", [
    "-lc",
    `command -v espeak >/dev/null 2>&1 && espeak ${JSON.stringify(payload)} || true`,
  ]).catch(() => undefined);

  return { spoken: true, text: payload, transport: "espeak-or-noop" };
}

function createTextToolOutput(text: string): ToolOutput[] {
  return [
    {
      text,
      type: "input_text",
    },
  ];
}

function createImageToolOutput(imageUrl: string, text?: string): ToolOutput[] {
  const outputs: ToolOutput[] = [
    {
      detail: "original",
      image_url: imageUrl,
      type: "input_image",
    },
  ];

  if (text?.trim()) {
    outputs.push({
      text,
      type: "input_text",
    });
  }

  return outputs;
}

function formatToolJson(value: unknown) {
  const payload = formatJson(value);
  return payload.length > 12_000 ? `${payload.slice(0, 11_997)}...` : payload;
}

function parseToolArguments(argumentsJson: string | undefined) {
  if (!argumentsJson || !argumentsJson.trim()) {
    return {} as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(argumentsJson) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new RunnerCoreError(
      `Invalid JSON arguments for tool call: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "invalid_tool_arguments",
        hint: "Ensure the model emits a valid JSON object for the tool call.",
        statusCode: 400,
      },
    );
  }
}

function readStringArg(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readNumberArg(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function executeWorkspaceToolCall(
  toolName: string,
  argumentsJson: string | undefined,
  options: AgentToolContext,
) {
  const args = parseToolArguments(argumentsJson);

  switch (toolName) {
    case "workspace_list_files": {
      const path = readStringArg(args.path, ".");
      const depth = Math.max(0, Math.min(5, Math.trunc(readNumberArg(args.depth, 2))));
      const entries = await listWorkspaceEntries(options.workspacePath, path, depth);
      return createTextToolOutput(
        [
          `workspace_list_files completed for ${path} (depth ${depth}).`,
          formatToolJson(entries),
        ].join("\n\n"),
      );
    }
    case "workspace_read_file": {
      const path = readStringArg(args.path);
      const result = await readWorkspaceFile(options.workspacePath, path);
      return createTextToolOutput(
        [
          `workspace_read_file completed for ${path}.`,
          result.truncated ? "The file was truncated for display." : "",
          "```text",
          result.text,
          "```",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    case "workspace_write_file": {
      const path = readStringArg(args.path);
      const content = readStringArg(args.content);
      const result = await writeWorkspaceFile(options.workspacePath, path, content);
      return createTextToolOutput(
        [
          `workspace_write_file completed for ${path}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "workspace_search_text": {
      const path = readStringArg(args.path, ".");
      const query = readStringArg(args.query);
      const result = await searchWorkspaceText(options.workspacePath, query, path);
      return createTextToolOutput(
        [
          `workspace_search_text completed for ${JSON.stringify(query)} in ${path}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "workspace_run_terminal": {
      const command = readStringArg(args.command);
      const timeoutMs = Math.trunc(readNumberArg(args.timeoutMs, defaultTerminalTimeoutMs));
      const result = await runTerminalCommand(
        options.workspacePath,
        command,
        timeoutMs,
        Boolean(options.allowDangerousCommands),
        options.signal,
      );
      return createTextToolOutput(
        [
          `workspace_run_terminal completed for ${JSON.stringify(command)}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "workspace_speak": {
      const text = readStringArg(args.text);
      const result = await speakText(text);
      return createTextToolOutput(
        [
          `workspace_speak completed for ${JSON.stringify(text)}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_open_target": {
      const target = readStringArg(args.target);
      const kind = readStringArg(args.kind);
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop launch actions.",
            statusCode: 400,
          },
        );
      }
      const result = await openDesktopTarget(options.workspacePath, target, kind);
      return createTextToolOutput(
        [
          `desktop_open_target completed for ${JSON.stringify(target)}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_get_environment": {
      const result = await getDesktopEnvironment(options.workspacePath);
      return createTextToolOutput(
        [
          "desktop_get_environment completed.",
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_move_pointer": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop pointer actions.",
            statusCode: 400,
          },
        );
      }
      const x = readNumberArg(args.x, 0);
      const y = readNumberArg(args.y, 0);
      const result = await moveDesktopPointer(x, y);
      return createTextToolOutput(
        [
          `desktop_move_pointer completed for ${x},${y}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_click_point": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop click actions.",
            statusCode: 400,
          },
        );
      }
      const x = readNumberArg(args.x, 0);
      const y = readNumberArg(args.y, 0);
      const button = readStringArg(args.button, "left") as "left" | "middle" | "right";
      const clicks = Math.max(1, Math.trunc(readNumberArg(args.clicks, 1)));
      const result = await clickDesktopPoint(x, y, button, clicks);
      return createTextToolOutput(
        [
          `desktop_click_point completed for ${x},${y} (${clicks} click(s)).`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_drag_path": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop drag actions.",
            statusCode: 400,
          },
        );
      }
      const path = Array.isArray(args.path)
        ? args.path
            .map((point) => {
              if (!point || typeof point !== "object") {
                return null;
              }

              const entry = point as Record<string, unknown>;
              return {
                x: readNumberArg(entry.x, 0),
                y: readNumberArg(entry.y, 0),
              };
            })
            .filter((point): point is { x: number; y: number } => point !== null)
        : [];
      const button = readStringArg(args.button, "left") as "left" | "middle" | "right";
      const result = await dragDesktopPath(path, button);
      return createTextToolOutput(
        [
          `desktop_drag_path completed with ${path.length} point(s).`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_scroll_wheel": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop scroll actions.",
            statusCode: 400,
          },
        );
      }
      const deltaX = readNumberArg(args.deltaX, 0);
      const deltaY = readNumberArg(args.deltaY, 0);
      const x = args.x === undefined ? undefined : readNumberArg(args.x, 0);
      const y = args.y === undefined ? undefined : readNumberArg(args.y, 0);
      const result = await scrollDesktopWheel(deltaX, deltaY, x, y);
      return createTextToolOutput(
        [
          `desktop_scroll_wheel completed with delta ${deltaX},${deltaY}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_type_text": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop typing actions.",
            statusCode: 400,
          },
        );
      }
      const text = readStringArg(args.text);
      const result = await typeDesktopText(text);
      return createTextToolOutput(
        [
          `desktop_type_text completed for ${JSON.stringify(text)}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_press_keys": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop key actions.",
            statusCode: 400,
          },
        );
      }
      const keys = Array.isArray(args.keys)
        ? args.keys.map((key) => String(key))
        : typeof args.keys === "string"
          ? [args.keys]
          : [];
      const result = await pressDesktopKeys(keys);
      return createTextToolOutput(
        [
          `desktop_press_keys completed for ${JSON.stringify(keys)}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_get_window_state": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop state inspection.",
            statusCode: 400,
          },
        );
      }
      const result = await getDesktopWindowState();
      return createTextToolOutput(
        [
          "desktop_get_window_state completed.",
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_context_snapshot": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop observation actions.",
            statusCode: 400,
          },
        );
      }
      const result = await captureDesktopContextSnapshot();
      return [
        ...(result.screen?.imageUrl ? createImageToolOutput(result.screen.imageUrl, "desktop_context_snapshot completed.") : []),
        { text: formatToolJson(result), type: "input_text" },
      ];
    }
    case "desktop_list_windows": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop window listing.",
            statusCode: 400,
          },
        );
      }
      const windows = await listDesktopWindows();
      return createTextToolOutput(
        [
          "desktop_list_windows completed.",
          formatToolJson(windows),
        ].join("\n\n"),
      );
    }
    case "desktop_focus_window": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop focus actions.",
            statusCode: 400,
          },
        );
      }
      const query = readStringArg(args.query);
      const matchMode = readStringArg(args.match, "any") as "any" | "process" | "title";
      const index = Math.trunc(readNumberArg(args.index, 0));
      const focused = await focusDesktopWindow(query, matchMode, index);
      return createTextToolOutput(
        [
          `desktop_focus_window completed for ${JSON.stringify(query)}.`,
          formatToolJson(focused),
        ].join("\n\n"),
      );
    }
    case "desktop_read_clipboard": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop clipboard access.",
            statusCode: 400,
          },
        );
      }
      const result = await readDesktopClipboardText();
      return createTextToolOutput(
        [
          "desktop_read_clipboard completed.",
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_write_clipboard": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop clipboard access.",
            statusCode: 400,
          },
        );
      }
      const text = readStringArg(args.text);
      const result = await writeDesktopClipboardText(text);
      return createTextToolOutput(
        [
          `desktop_write_clipboard completed for ${JSON.stringify(text)}.`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    case "desktop_capture_screen": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop screen capture.",
            statusCode: 400,
          },
        );
      }
      const result = await captureDesktopScreen();
      return [
        ...createImageToolOutput(
          result.imageUrl,
          `desktop_capture_screen completed on ${result.platform} using ${result.transport}.`,
        ),
        { text: formatToolJson(result), type: "input_text" },
      ];
    }
    case "desktop_run_sequence": {
      if (!shouldEnableDesktopControl()) {
        throw new RunnerCoreError(
          "Desktop control is disabled in this run environment.",
          {
            code: "desktop_control_disabled",
            hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow desktop sequence execution.",
            statusCode: 400,
          },
        );
      }
      const steps = Array.isArray(args.steps) ? (args.steps as any[]) : [];
      const result = await runDesktopActionSequence(options.workspacePath, steps, options.signal);
      return createTextToolOutput(
        [
          `desktop_run_sequence completed with ${steps.length} step(s).`,
          formatToolJson(result),
        ].join("\n\n"),
      );
    }
    default:
      throw new RunnerCoreError(`Unknown agent tool: ${toolName}`, {
        code: "unknown_tool",
        hint: "Only the published workspace tools are available in this harness.",
        statusCode: 400,
      });
  }
}

export async function executeAgentFunctionCall(
  toolName: string,
  argumentsJson: string | undefined,
  options: AgentToolContext,
) {
  return await executeWorkspaceToolCall(toolName, argumentsJson, options);
}

export function buildAgentCapabilityManifest(options: {
  workspacePath: string;
}) {
  const allowDangerousCommands = shouldAllowDangerousTerminalCommands();
  const blockedPatterns = blockedCommandDescriptions;
  const terminalPolicy = {
    allowDangerousCommands,
    blockedPatterns,
    mode: allowDangerousCommands ? ("relaxed" as const) : ("guarded" as const),
  };
  const desktopBackend = describeDesktopControlBackend();

  return {
    capabilities: [
      {
        category: "browser",
        description: "Control the active browser session with computer actions or exec_js.",
        enabled: true,
        name: "Browser automation",
        notes: [
          "Supports both native computer actions and the persistent Playwright code loop.",
          "Best for web apps, dashboards, and browser-based workflows.",
        ],
      },
      {
        category: "terminal",
        description: "Run shell commands inside the isolated run workspace.",
        enabled: true,
        name: "Workspace terminal",
        notes: [
          terminalPolicy.mode === "guarded"
            ? "Destructive patterns are blocked by default."
            : "Destructive patterns are allowed because the operator enabled the relaxed mode.",
          "Commands always run inside the run workspace root.",
        ],
      },
      {
        category: "filesystem",
        description: "List, read, write, and search files inside the workspace.",
        enabled: true,
        name: "Workspace files",
        notes: [
          "All paths are validated to stay inside the workspace root.",
          "Useful for code edits, inspections, and artifact management.",
        ],
      },
      {
        category: "audio",
        description: "Speak short messages through the operating system when supported.",
        enabled: true,
        name: "Text-to-speech",
        notes: [
          "Best-effort only; missing system support is handled without crashing the run.",
        ],
      },
      {
        category: "desktop",
        description: "Native OS-level desktop launch, input, observation, focus, and environment primitives.",
        enabled: shouldEnableDesktopControl() && desktopBackend.supported,
        name: "Desktop control",
        notes: [
          `Current backend: ${desktopBackend.backend}.`,
          "Supports opening URLs, files, and application targets through the host OS default handler.",
          "Adds pointer movement, click actions, drag paths, scroll input, text entry, hotkeys, clipboard access, screen capture, window-state inspection, a combined desktop snapshot, window listing, and focus control as the next layer toward full computer control.",
        ],
      },
      {
        category: "memory",
        description: "Scenario-scoped history and console state.",
        enabled: true,
        name: "Run memory",
        notes: [
          "The console preserves run context, events, screenshots, and replay artifacts.",
        ],
      },
      {
        category: "integration",
        description: "HTTP and SSE endpoints for orchestration and event streaming.",
        enabled: true,
        name: "Integration surface",
        notes: [
          "Supports scenario discovery, run control, live events, and replay retrieval.",
        ],
      },
    ],
    generatedAt: new Date().toISOString(),
    terminalPolicy,
    title: "OpenAI CUA Sample App capability manifest",
    workspacePolicy: {
      description:
        "Runs operate inside an isolated mutable workspace copied from the scenario template.",
      rootPath: options.workspacePath,
    },
  };
}

export function buildAgentToolDefinitions(): ToolDefinition[] {
  return [
    {
      description:
        "List files and folders inside the current run workspace. Use this before reading or editing files.",
      name: "workspace_list_files",
      parameters: {
        additionalProperties: false,
        properties: {
          depth: { default: 2, minimum: 0, maximum: 5, type: "number" },
          path: { default: ".", type: "string" },
        },
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Read a UTF-8 file from the run workspace and return its contents for analysis or patching.",
      name: "workspace_read_file",
      parameters: {
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Write or replace a UTF-8 file inside the run workspace. The path must stay inside the workspace root.",
      name: "workspace_write_file",
      parameters: {
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          path: { type: "string" },
        },
        required: ["path", "content"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Search workspace files for a text string and return matching paths and line snippets.",
      name: "workspace_search_text",
      parameters: {
        additionalProperties: false,
        properties: {
          path: { default: ".", type: "string" },
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Run a shell command inside the run workspace and return stdout, stderr, exit details, and duration.",
      name: "workspace_run_terminal",
      parameters: {
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          timeoutMs: { default: defaultTerminalTimeoutMs, minimum: 1000, maximum: 300000, type: "number" },
        },
        required: ["command"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Speak a short message using the operating system's available text-to-speech support when present.",
      name: "workspace_speak",
      parameters: {
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Open a URL, file path, or application with the operating system's default handler. Relative paths are resolved inside the current run workspace.",
      name: "desktop_open_target",
      parameters: {
        additionalProperties: false,
        properties: {
          kind: {
            default: "auto",
            enum: ["auto", "url", "path", "application"],
            type: "string",
          },
          target: { type: "string" },
        },
        required: ["target"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Inspect the host desktop environment before taking a desktop action.",
      name: "desktop_get_environment",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Capture the current desktop screen and return it as an image plus a short metadata summary.",
      name: "desktop_capture_screen",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Move the host pointer to an absolute screen coordinate.",
      name: "desktop_move_pointer",
      parameters: {
        additionalProperties: false,
        properties: {
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["x", "y"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Click the host desktop at an absolute screen coordinate. Use clicks > 1 for double-clicks or triple-clicks.",
      name: "desktop_click_point",
      parameters: {
        additionalProperties: false,
        properties: {
          button: {
            default: "left",
            enum: ["left", "middle", "right"],
            type: "string",
          },
          clicks: { default: 1, minimum: 1, maximum: 10, type: "number" },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["x", "y"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Drag the host pointer across a sequence of screen points.",
      name: "desktop_drag_path",
      parameters: {
        additionalProperties: false,
        properties: {
          button: {
            default: "left",
            enum: ["left", "middle", "right"],
            type: "string",
          },
          path: {
            items: {
              additionalProperties: false,
              properties: {
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["x", "y"],
              type: "object",
            },
            minItems: 2,
            type: "array",
          },
        },
        required: ["path"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Scroll the host desktop using mouse wheel deltas, optionally after moving to a point.",
      name: "desktop_scroll_wheel",
      parameters: {
        additionalProperties: false,
        properties: {
          deltaX: { default: 0, type: "number" },
          deltaY: { default: 0, type: "number" },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["deltaX", "deltaY"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Type text into the focused host application using native desktop input.",
      name: "desktop_type_text",
      parameters: {
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Press one or more host keyboard keys as a hotkey sequence.",
      name: "desktop_press_keys",
      parameters: {
        additionalProperties: false,
        properties: {
          keys: {
            items: { type: "string" },
            type: "array",
          },
        },
        required: ["keys"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Read the current focused window title, foreground application, and screen details.",
      name: "desktop_get_window_state",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Capture a combined desktop snapshot including the screen image, window state, windows list, and clipboard.",
      name: "desktop_context_snapshot",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Enumerate top-level desktop windows available to the host OS.",
      name: "desktop_list_windows",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Focus a top-level desktop window by matching its title or process name.",
      name: "desktop_focus_window",
      parameters: {
        additionalProperties: false,
        properties: {
          index: { default: 0, minimum: 0, type: "number" },
          match: {
            default: "any",
            enum: ["any", "process", "title"],
            type: "string",
          },
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Read text from the host system clipboard.",
      name: "desktop_read_clipboard",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Write text to the host system clipboard.",
      name: "desktop_write_clipboard",
      parameters: {
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    {
      description:
        "Execute a sequenced set of desktop actions in order and return a structured trace.",
      name: "desktop_run_sequence",
      parameters: {
        additionalProperties: false,
        properties: {
          steps: {
            items: {
              additionalProperties: false,
              properties: {
                button: {
                  enum: ["left", "middle", "right"],
                  type: "string",
                },
                clicks: { default: 1, minimum: 1, maximum: 10, type: "number" },
                deltaX: { default: 0, type: "number" },
                deltaY: { default: 0, type: "number" },
                kind: {
                  enum: ["auto", "url", "path", "application"],
                  type: "string",
                },
                keys: {
                  items: { type: "string" },
                  type: "array",
                },
                note: { type: "string" },
                path: {
                  items: {
                    additionalProperties: false,
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                    },
                    required: ["x", "y"],
                    type: "object",
                  },
                  minItems: 2,
                  type: "array",
                },
                target: { type: "string" },
                text: { type: "string" },
                index: { type: "number" },
                match: {
                  enum: ["any", "process", "title"],
                  type: "string",
                },
                query: { type: "string" },
                type: {
                  enum: [
                    "click_point",
                    "drag_path",
                    "focus_window",
                    "get_window_state",
                    "list_windows",
                    "move_pointer",
                    "open_target",
                    "press_keys",
                    "read_clipboard",
                    "scroll_wheel",
                    "snapshot",
                    "type_text",
                    "wait",
                    "write_clipboard",
                  ],
                  type: "string",
                },
                waitMs: { type: "number" },
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["type"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["steps"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
  ];
}

export function buildAgentCapabilityBanner(options: {
  allowDangerousCommands?: boolean;
  workspacePath: string;
}) {
  const permissions = options.allowDangerousCommands
    ? "Terminal commands are allowed without the default destructive-command guard."
    : "Terminal commands use a safety guard for destructive patterns unless explicitly enabled through CUA_ALLOW_DANGEROUS_COMMANDS=true.";

  return [
    "You are a senior chat-first computer-use assistant inside a production-grade run workspace.",
    "Desktop launch actions are available for opening URLs, files, and applications through the host OS.",
    "Think privately. Never expose hidden reasoning, runner logs, orchestration steps, policy text, or safety checks to the user.",
    "Visible replies must read like a strong assistant: direct, concise, and outcome-focused.",
    `Workspace root: ${options.workspacePath}`,
    "Operational contract:",
    "- Treat the chat as the public interface and the tools as hidden implementation detail.",
    "- Infer the user's goal, choose the smallest useful action, and keep going until the task is complete or genuinely blocked.",
    "- Verify results after meaningful actions before claiming success.",
    "- Prefer structured recovery over explanation when something fails.",
    "Available tools:",
    "- browser (via computer actions in native mode or exec_js in code mode)",
    "- desktop_open_target(target, kind?)",
    "- desktop_get_environment()",
    "- desktop_capture_screen()",
    "- desktop_move_pointer(x, y)",
    "- desktop_click_point(x, y, button?, clicks?)",
    "- desktop_drag_path(path, button?) and desktop_scroll_wheel(deltaX, deltaY, x?, y?)",
    "- desktop_type_text(text)",
    "- desktop_press_keys(keys)",
    "- desktop_get_window_state()",
    "- desktop_context_snapshot()",
    "- desktop_list_windows() and desktop_focus_window(query, match?, index?)",
    "- desktop_read_clipboard() and desktop_write_clipboard(text)",
    "- desktop_run_sequence(steps)",
    "- workspace_list_files(path?, depth?)",
    "- workspace_read_file(path)",
    "- workspace_write_file(path, content)",
    "- workspace_search_text(query, path?)",
    "- workspace_run_terminal(command, timeoutMs?)",
    "- workspace_speak(text)",
    "- memory (scenario-scoped chat history in the console)",
    "- integration (HTTP and SSE endpoints for external orchestration)",
    permissions,
    "Use the smallest tool necessary, verify state after every meaningful action, and summarize only the concrete result before ending the turn.",
  ].join("\n");
}

export function shouldAllowDangerousTerminalCommands() {
  return process.env.CUA_ALLOW_DANGEROUS_COMMANDS === "true";
}

function shouldEnableDesktopControl() {
  return process.env.CUA_ENABLE_DESKTOP_CONTROL !== "false";
}

function quotePowerShellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function inferDesktopTargetKind(target: string) {
  const trimmed = target.trim();

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return "url" as const;
  }

  return "path" as const;
}

function resolveDesktopTarget(workspacePath: string, target: string, kind?: string) {
  const trimmed = target.trim();

  if (!trimmed) {
    throw new RunnerCoreError("Desktop target cannot be empty.", {
      code: "empty_desktop_target",
      hint: "Provide a URL, file path, or application name to open.",
      statusCode: 400,
    });
  }

  const resolvedKind = kind === "url" || kind === "path" || kind === "application"
    ? kind
    : inferDesktopTargetKind(trimmed);

  if (resolvedKind === "url") {
    try {
      const normalized = new URL(trimmed).href;
      return { kind: resolvedKind, target: normalized };
    } catch {
      throw new RunnerCoreError(`Invalid desktop URL target: ${target}`, {
        code: "invalid_desktop_target",
        hint: "Desktop URLs must be valid absolute URLs such as https://example.com.",
        statusCode: 400,
      });
    }
  }

  if (resolvedKind === "path") {
    return {
      kind: resolvedKind,
      target: isAbsolute(trimmed) ? resolve(trimmed) : ensureWithinWorkspace(workspacePath, trimmed),
    };
  }

  return { kind: resolvedKind, target: trimmed };
}

async function openDesktopTarget(workspacePath: string, target: string, kind?: string) {
  const resolved = resolveDesktopTarget(workspacePath, target, kind);

  try {
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop';",
        `Start-Process ${quotePowerShellSingleQuoted(resolved.target)};`,
      ].join(" ");

      await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
        windowsHide: true,
      });
      return {
        opened: true,
        target: resolved.target,
        kind: resolved.kind,
        transport: "powershell-start-process",
      };
    }

    if (process.platform === "darwin") {
      await execFileAsync("open", [resolved.target]);
      return {
        opened: true,
        target: resolved.target,
        kind: resolved.kind,
        transport: "open",
      };
    }

    await execFileAsync("xdg-open", [resolved.target]);
    return {
      opened: true,
      target: resolved.target,
      kind: resolved.kind,
      transport: "xdg-open",
    };
  } catch (error) {
    const failure = error as { message?: string };
    throw new RunnerCoreError(
      `Failed to open desktop target ${JSON.stringify(resolved.target)}.`,
      {
        code: "desktop_open_failed",
        hint: failure.message ?? "Verify the target exists and the OS has a default handler for it.",
        statusCode: 400,
      },
    );
  }
}

async function getDesktopEnvironment(workspacePath: string) {
  const backend = describeDesktopControlBackend();

  return {
    arch: process.arch,
    backend: backend.backend,
    capabilities: {
      click: process.platform === "win32" || process.platform === "linux",
      clipboard: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
      keyboard: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
      openTarget: true,
      pointer: process.platform === "win32" || process.platform === "linux",
      screenCapture: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
      sequence: true,
      typing: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
      windowState: true,
    },
    currentWorkingDirectory: process.cwd(),
    desktopControlEnabled: shouldEnableDesktopControl(),
    platform: process.platform,
    workspacePath,
  };
}
