import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { RunnerCoreError } from "./errors.js";

const execFileAsync = promisify(execFile);

export type DesktopPointerButton = "left" | "middle" | "right";

export type DesktopPointerActionResult = {
  platform: NodeJS.Platform;
  succeeded: boolean;
  transport: string;
  x: number;
  y: number;
};

export type DesktopDragActionResult = {
  button: DesktopPointerButton;
  path: Array<{ x: number; y: number }>;
  platform: NodeJS.Platform;
  succeeded: boolean;
  transport: string;
};

export type DesktopScrollActionResult = {
  deltaX: number;
  deltaY: number;
  platform: NodeJS.Platform;
  succeeded: boolean;
  transport: string;
  x?: number;
  y?: number;
};

export type DesktopTextActionResult = {
  platform: NodeJS.Platform;
  succeeded: boolean;
  text: string;
  transport: string;
};

function quotePowerShellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function isWindows() {
  return process.platform === "win32";
}

function isMac() {
  return process.platform === "darwin";
}

function isLinux() {
  return process.platform === "linux";
}

function normalizeButton(button: DesktopPointerButton) {
  switch (button) {
    case "middle":
      return { button: 2, downFlag: 0x0020, upFlag: 0x0040, xdotool: 2 };
    case "right":
      return { button: 3, downFlag: 0x0008, upFlag: 0x0010, xdotool: 3 };
    case "left":
    default:
      return { button: 1, downFlag: 0x0002, upFlag: 0x0004, xdotool: 1 };
  }
}

function clampDesktopClickCount(clicks: number) {
  const normalized = Math.trunc(Number(clicks));

  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new RunnerCoreError("Desktop click count must be a positive integer.", {
      code: "invalid_desktop_click_count",
      hint: "Provide a click count such as 1, 2, or 3.",
      statusCode: 400,
    });
  }

  return Math.min(normalized, 10);
}

function normalizeDesktopPoint(point: { x: unknown; y: unknown }) {
  return {
    x: Math.trunc(Number(point.x ?? 0)),
    y: Math.trunc(Number(point.y ?? 0)),
  };
}

function normalizeDesktopKeys(keys: string[]) {
  const tokens = keys
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => key.toUpperCase());

  if (tokens.length === 0) {
    throw new RunnerCoreError("Desktop key list cannot be empty.", {
      code: "empty_desktop_keys",
      hint: "Provide one or more keys such as ['CTRL', 'L'] or ['ENTER'].",
      statusCode: 400,
    });
  }

  return tokens;
}

function escapeSendKeysText(text: string) {
  return Array.from(text)
    .map((character) => {
      switch (character) {
        case "\n":
        case "\r":
          return "{ENTER}";
        case "+":
          return "{+}";
        case "^":
          return "{^}";
        case "%":
          return "{%}";
        case "~":
          return "{~}";
        case "(":
          return "{(}";
        case ")":
          return "{)}";
        case "{":
          return "{{}";
        case "}":
          return "{}}";
        case "[":
          return "{[}";
        case "]":
          return "{]}";
        default:
          return character;
      }
    })
    .join("");
}

function normalizeLinuxKeyToken(key: string) {
  const token = key.trim().toLowerCase();

  if (!token) {
    return null;
  }

  const aliases: Record<string, string> = {
    alt: "alt",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    backspace: "BackSpace",
    cmd: "super",
    command: "super",
    ctrl: "ctrl",
    delete: "Delete",
    del: "Delete",
    enter: "Return",
    esc: "Escape",
    escape: "Escape",
    return: "Return",
    shift: "shift",
    space: "space",
    tab: "Tab",
    win: "super",
    meta: "super",
    option: "alt",
    super: "super",
  };

  if (aliases[token]) {
    return aliases[token];
  }

  const functionKey = token.match(/^f(\d{1,2})$/);
  if (functionKey) {
    return `F${functionKey[1]}`;
  }

  if (token.length === 1) {
    return token;
  }

  return token;
}

function buildLinuxCombo(keys: string[]) {
  const normalized = normalizeDesktopKeys(keys)
    .map(normalizeLinuxKeyToken)
    .filter((token): token is string => Boolean(token));

  const modifiers: string[] = [];
  let mainKey: string | undefined;

  for (const key of normalized) {
    if (["ctrl", "shift", "alt", "super"].includes(key)) {
      modifiers.push(key);
      continue;
    }

    mainKey = key;
  }

  if (!mainKey) {
    throw new RunnerCoreError(
      "Desktop key sequences must include a non-modifier key.",
      {
        code: "desktop_keys_missing_main_key",
        hint: "Provide a hotkey sequence such as ['CTRL', 'L'] or ['ENTER'].",
        statusCode: 400,
      },
    );
  }

  return {
    mainKey,
    modifiers,
  };
}

function buildWindowsKeySpec(keys: string[]) {
  const normalized = normalizeDesktopKeys(keys);
  const modifiers: string[] = [];
  let mainKey = normalized[normalized.length - 1] ?? "";

  for (const key of normalized.slice(0, -1)) {
    switch (key) {
      case "CTRL":
      case "CONTROL":
        modifiers.push("^");
        break;
      case "ALT":
      case "OPTION":
        modifiers.push("%");
        break;
      case "SHIFT":
        modifiers.push("+");
        break;
      case "WIN":
      case "WINDOWS":
      case "CMD":
      case "COMMAND":
      case "META":
      case "SUPER":
        modifiers.push("^");
        break;
      default:
        mainKey = key;
        break;
    }
  }

  if (!mainKey) {
    throw new RunnerCoreError(
      "Desktop key sequences must include a non-modifier key.",
      {
        code: "desktop_keys_missing_main_key",
        hint: "Provide a hotkey sequence such as ['CTRL', 'L'] or ['ENTER'].",
        statusCode: 400,
      },
    );
  }

  const specialKeys: Record<string, string> = {
    ARROWDOWN: "{DOWN}",
    ARROWLEFT: "{LEFT}",
    ARROWRIGHT: "{RIGHT}",
    ARROWUP: "{UP}",
    BACKSPACE: "{BACKSPACE}",
    DELETE: "{DELETE}",
    DEL: "{DELETE}",
    END: "{END}",
    ENTER: "{ENTER}",
    ESC: "{ESC}",
    ESCAPE: "{ESC}",
    HOME: "{HOME}",
    INSERT: "{INSERT}",
    PAGEDOWN: "{PGDN}",
    PAGEUP: "{PGUP}",
    RETURN: "{ENTER}",
    SPACE: " ",
    TAB: "{TAB}",
  };

  const functionKey = mainKey.match(/^F(\d{1,2})$/);
  const keyPart =
    specialKeys[mainKey] ?? (functionKey ? `{F${functionKey[1]}}` : mainKey.length === 1 ? mainKey.toLowerCase() : `{${mainKey}}`);

  return `${modifiers.join("")}${keyPart}`;
}

async function runWindowsPowerShell(script: string) {
  return await execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true },
  );
}

async function runLinuxXdotool(args: string[]) {
  return await execFileAsync("xdotool", args, { windowsHide: true });
}

async function tryRunLinuxXdotool(args: string[]) {
  try {
    return await runLinuxXdotool(args);
  } catch (error) {
    throw new RunnerCoreError(
      "Linux desktop automation requires xdotool to be installed.",
      {
        code: "desktop_backend_unavailable",
        hint:
          "Install xdotool, or run the sample on Windows where the built-in PowerShell backend is available.",
        statusCode: 400,
      },
    );
  }
}

export function describeDesktopControlBackend() {
  if (isWindows()) {
    return { backend: "windows-powershell", supported: true };
  }

  if (isMac()) {
    return { backend: "macos-osascript", supported: true };
  }

  if (isLinux()) {
    return { backend: "linux-xdotool", supported: true };
  }

  return { backend: process.platform, supported: false };
}

export async function moveDesktopPointer(x: number, y: number) {
  const targetX = Math.trunc(x);
  const targetY = Math.trunc(y);

  if (isWindows()) {
    const script = [
      "Add-Type @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class DesktopNative {",
      "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);",
      "}",
      "'@;",
      `[DesktopNative]::SetCursorPos(${targetX}, ${targetY}) | Out-Null;`,
    ].join("\n");

    await runWindowsPowerShell(script);
    return {
      platform: process.platform,
      succeeded: true,
      transport: "powershell-setcursorpos",
      x: targetX,
      y: targetY,
    } satisfies DesktopPointerActionResult;
  }

  if (isLinux()) {
    await tryRunLinuxXdotool(["mousemove", String(targetX), String(targetY)]);
    return {
      platform: process.platform,
      succeeded: true,
      transport: "xdotool-mousemove",
      x: targetX,
      y: targetY,
    } satisfies DesktopPointerActionResult;
  }

  throw new RunnerCoreError(
    "Pointer movement is not supported on this desktop backend yet.",
    {
      code: "desktop_pointer_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function clickDesktopPoint(
  x: number,
  y: number,
  button: DesktopPointerButton = "left",
  clicks = 1,
) {
  const targetX = Math.trunc(x);
  const targetY = Math.trunc(y);
  const buttonInfo = normalizeButton(button);
  const clickCount = clampDesktopClickCount(clicks);

  if (isWindows()) {
    const script = [
      "Add-Type @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class DesktopNative {",
      '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
      "}",
      "'@;",
      `[DesktopNative]::SetCursorPos(${targetX}, ${targetY}) | Out-Null;`,
      `for ($i = 0; $i -lt ${clickCount}; $i++) {`,
      `  [DesktopNative]::mouse_event(${buttonInfo.downFlag}, 0, 0, 0, [UIntPtr]::Zero);`,
      `  [DesktopNative]::mouse_event(${buttonInfo.upFlag}, 0, 0, 0, [UIntPtr]::Zero);`,
      `  if ($i -lt (${clickCount} - 1)) { Start-Sleep -Milliseconds 70 }`,
      "}",
    ].join("\n");

    await runWindowsPowerShell(script);
    return {
      platform: process.platform,
      succeeded: true,
      transport: clickCount > 1 ? "powershell-mouse_event-multiclick" : "powershell-mouse_event",
      x: targetX,
      y: targetY,
    } satisfies DesktopPointerActionResult;
  }

  if (isLinux()) {
    const clickScript = [
      "set -eu",
      `xdotool mousemove ${targetX} ${targetY}`,
      `for i in $(seq 1 ${clickCount}); do`,
      `  xdotool click ${buttonInfo.xdotool}`,
      `  if [ "$i" -lt ${clickCount} ]; then sleep 0.07; fi`,
      "done",
    ].join("\n");

    await runLinuxShell(clickScript);
    return {
      platform: process.platform,
      succeeded: true,
      transport: clickCount > 1 ? "xdotool-click-multiclick" : "xdotool-click",
      x: targetX,
      y: targetY,
    } satisfies DesktopPointerActionResult;
  }

  throw new RunnerCoreError(
    "Mouse clicks are not supported on this desktop backend yet.",
    {
      code: "desktop_click_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function dragDesktopPath(
  pathPoints: Array<{ x: number; y: number }>,
  button: DesktopPointerButton = "left",
) {
  const points = Array.isArray(pathPoints)
    ? pathPoints.map((point) => normalizeDesktopPoint(point)).filter(Boolean)
    : [];
  const buttonInfo = normalizeButton(button);

  if (points.length < 2) {
    throw new RunnerCoreError("Desktop drag path requires at least two points.", {
      code: "desktop_drag_path_too_short",
      hint: "Provide a path array with at least a start and end point.",
      statusCode: 400,
    });
  }

  if (isWindows()) {
    const pathScript = [
      "Add-Type @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class DesktopNative {",
      '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
      "}",
      "'@;",
      `[DesktopNative]::SetCursorPos(${points[0].x}, ${points[0].y}) | Out-Null;`,
      `[DesktopNative]::mouse_event(${buttonInfo.downFlag}, 0, 0, 0, [UIntPtr]::Zero);`,
      ...points.slice(1).map((point) => `[DesktopNative]::SetCursorPos(${point.x}, ${point.y}) | Out-Null;`),
      `[DesktopNative]::mouse_event(${buttonInfo.upFlag}, 0, 0, 0, [UIntPtr]::Zero);`,
    ].join("\n");

    await runWindowsPowerShell(pathScript);
    return {
      button,
      path: points,
      platform: process.platform,
      succeeded: true,
      transport: "powershell-drag",
    } satisfies DesktopDragActionResult;
  }

  if (isLinux()) {
    const script = [
      "set -eu",
      `xdotool mousemove ${points[0].x} ${points[0].y}`,
      `xdotool mousedown ${buttonInfo.xdotool}`,
      ...points.slice(1).map((point) => `xdotool mousemove ${point.x} ${point.y}`),
      `xdotool mouseup ${buttonInfo.xdotool}`,
    ].join("\n");

    await runLinuxShell(script);
    return {
      button,
      path: points,
      platform: process.platform,
      succeeded: true,
      transport: "xdotool-drag",
    } satisfies DesktopDragActionResult;
  }

  throw new RunnerCoreError(
    "Pointer dragging is not supported on this desktop backend yet.",
    {
      code: "desktop_drag_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function scrollDesktopWheel(
  deltaX: number,
  deltaY: number,
  x?: number,
  y?: number,
) {
  const scrollX = Math.trunc(Number(deltaX));
  const scrollY = Math.trunc(Number(deltaY));
  const targetX = Number.isFinite(Number(x)) ? Math.trunc(Number(x)) : undefined;
  const targetY = Number.isFinite(Number(y)) ? Math.trunc(Number(y)) : undefined;

  if (scrollX === 0 && scrollY === 0) {
    throw new RunnerCoreError("Desktop scroll delta cannot be zero.", {
      code: "empty_desktop_scroll_delta",
      hint: "Provide a non-zero horizontal or vertical scroll delta.",
      statusCode: 400,
    });
  }

  if (isWindows()) {
    const scripts: string[] = [
      "Add-Type @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class DesktopNative {",
      '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
      "}",
      "'@;",
    ];

    if (typeof targetX === "number" && typeof targetY === "number") {
      scripts.push(`[DesktopNative]::SetCursorPos(${targetX}, ${targetY}) | Out-Null;`);
    }

    if (scrollY !== 0) {
      scripts.push(`[DesktopNative]::mouse_event(0x0800, 0, 0, ${scrollY * 120}, [UIntPtr]::Zero);`);
    }
    if (scrollX !== 0) {
      scripts.push(`[DesktopNative]::mouse_event(0x1000, 0, 0, ${scrollX * 120}, [UIntPtr]::Zero);`);
    }

    await runWindowsPowerShell(scripts.join("\n"));
    return {
      deltaX: scrollX,
      deltaY: scrollY,
      platform: process.platform,
      succeeded: true,
      transport: "powershell-mouse-wheel",
      ...(typeof targetX === "number" ? { x: targetX } : {}),
      ...(typeof targetY === "number" ? { y: targetY } : {}),
    } satisfies DesktopScrollActionResult;
  }

  if (isLinux()) {
    const scrollCommands: string[] = ["set -eu"];

    if (typeof targetX === "number" && typeof targetY === "number") {
      scrollCommands.push(`xdotool mousemove ${targetX} ${targetY}`);
    }

    const verticalSteps = Math.abs(scrollY);
    const horizontalSteps = Math.abs(scrollX);

    if (verticalSteps > 0) {
      const button = scrollY > 0 ? 4 : 5;
      for (let index = 0; index < verticalSteps; index += 1) {
        scrollCommands.push(`xdotool click ${button}`);
      }
    }

    if (horizontalSteps > 0) {
      const button = scrollX > 0 ? 6 : 7;
      for (let index = 0; index < horizontalSteps; index += 1) {
        scrollCommands.push(`xdotool click ${button}`);
      }
    }

    await runLinuxShell(scrollCommands.join("\n"));
    return {
      deltaX: scrollX,
      deltaY: scrollY,
      platform: process.platform,
      succeeded: true,
      transport: "xdotool-scroll",
      ...(typeof targetX === "number" ? { x: targetX } : {}),
      ...(typeof targetY === "number" ? { y: targetY } : {}),
    } satisfies DesktopScrollActionResult;
  }

  throw new RunnerCoreError(
    "Mouse scrolling is not supported on this desktop backend yet.",
    {
      code: "desktop_scroll_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function typeDesktopText(text: string) {
  const payload = text ?? "";

  if (payload.trim().length === 0) {
    throw new RunnerCoreError("Desktop text input cannot be empty.", {
      code: "empty_desktop_text",
      hint: "Provide a non-empty string for the desktop typing action.",
      statusCode: 400,
    });
  }

  if (isWindows()) {
    const escaped = escapeSendKeysText(payload);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      `$payload = ${quotePowerShellSingleQuoted(escaped)};`,
      "[System.Windows.Forms.SendKeys]::SendWait($payload);",
    ].join(" ");

    await runWindowsPowerShell(script);
    return {
      platform: process.platform,
      succeeded: true,
      text: payload,
      transport: "powershell-sendkeys",
    } satisfies DesktopTextActionResult;
  }

  if (isLinux()) {
    await tryRunLinuxXdotool(["type", "--delay", "0", payload]);
    return {
      platform: process.platform,
      succeeded: true,
      text: payload,
      transport: "xdotool-type",
    } satisfies DesktopTextActionResult;
  }

  if (isMac()) {
    const escaped = payload.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    await execFileAsync("osascript", ["-e", script], { windowsHide: true });
    return {
      platform: process.platform,
      succeeded: true,
      text: payload,
      transport: "osascript-keystroke",
    } satisfies DesktopTextActionResult;
  }

  throw new RunnerCoreError(
    "Desktop typing is not supported on this desktop backend yet.",
    {
      code: "desktop_type_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux/macOS with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function pressDesktopKeys(keys: string[]) {
  const normalized = normalizeDesktopKeys(keys);

  if (isWindows()) {
    const sendKeys = buildWindowsKeySpec(normalized);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      `$payload = ${quotePowerShellSingleQuoted(sendKeys)};`,
      "[System.Windows.Forms.SendKeys]::SendWait($payload);",
    ].join(" ");

    await runWindowsPowerShell(script);
    return {
      platform: process.platform,
      succeeded: true,
      text: normalized.join("+"),
      transport: "powershell-sendkeys",
    } satisfies DesktopTextActionResult;
  }

  if (isLinux()) {
    const combo = buildLinuxCombo(normalized);
    const comboString = [
      ...combo.modifiers,
      combo.mainKey,
    ].filter(Boolean).join("+");
    await tryRunLinuxXdotool(["key", comboString]);
    return {
      platform: process.platform,
      succeeded: true,
      text: normalized.join("+"),
      transport: "xdotool-key",
    } satisfies DesktopTextActionResult;
  }

  if (isMac()) {
    throw new RunnerCoreError(
      "Desktop keyboard input is only partially implemented on macOS in this sample.",
      {
        code: "desktop_keys_not_supported",
        hint:
          "Use the browser computer tool or run the project on Windows/Linux where native keyboard automation is currently implemented.",
        statusCode: 400,
      },
    );
  }

  throw new RunnerCoreError(
    "Desktop keyboard input is not supported on this desktop backend yet.",
    {
      code: "desktop_keys_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux/macOS with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export type DesktopWindowState = {
  backend: string;
  platform: NodeJS.Platform;
  processId?: number;
  processName?: string;
  screenHeight?: number;
  screenWidth?: number;
  transport: string;
  windowTitle?: string;
};

export type DesktopWindowEntry = {
  active: boolean;
  backend: string;
  handle?: number;
  height?: number;
  index: number;
  platform: NodeJS.Platform;
  processId?: number;
  processName?: string;
  transport: string;
  width?: number;
  windowTitle?: string;
  x?: number;
  y?: number;
};

export type DesktopWindowMatchMode = "any" | "process" | "title";

export type DesktopClipboardResult = {
  platform: NodeJS.Platform;
  success: boolean;
  text: string;
  transport: string;
};

export type DesktopScreenCaptureResult = {
  bytes: number;
  height?: number;
  imageUrl: string;
  platform: NodeJS.Platform;
  success: boolean;
  transport: string;
  width?: number;
};

export type DesktopContextSnapshot = {
  backend: string;
  capturedAt: string;
  clipboard?: DesktopClipboardResult;
  errors: Array<{
    code: string;
    message: string;
    source: string;
  }>;
  platform: NodeJS.Platform;
  screen?: DesktopScreenCaptureResult;
  windowState?: DesktopWindowState;
  windows?: DesktopWindowEntry[];
};

export type DesktopSequenceStep = {
  button?: DesktopPointerButton;
  kind?: "auto" | "url" | "path" | "application";
  index?: number;
  keys?: string[];
  match?: DesktopWindowMatchMode;
  note?: string;
  query?: string;
  target?: string;
  text?: string;
  clicks?: number;
  deltaX?: number;
  deltaY?: number;
  path?: Array<{ x: number; y: number }>;
  type:
    | "click_point"
    | "drag_path"
    | "focus_window"
    | "get_window_state"
    | "list_windows"
    | "move_pointer"
    | "open_target"
    | "press_keys"
    | "read_clipboard"
    | "scroll_wheel"
    | "snapshot"
    | "type_text"
    | "wait"
    | "write_clipboard";
  waitMs?: number;
  x?: number;
  y?: number;
};

export type DesktopSequenceTraceItem = {
  error?: string;
  index: number;
  note?: string;
  result?: unknown;
  success: boolean;
  type: DesktopSequenceStep["type"];
};

export type DesktopSequenceResult = {
  backend: string;
  completedSteps: number;
  contextSnapshot?: DesktopContextSnapshot;
  failedStepIndex?: number;
  failedStepType?: DesktopSequenceStep["type"];
  platform: NodeJS.Platform;
  success: boolean;
  trace: DesktopSequenceTraceItem[];
  windowState?: DesktopWindowState;
};

function quoteShellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseKeyValueLines(output: string) {
  const result: Record<string, string> = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex < 1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

function runLinuxShell(command: string) {
  return execFileAsync("sh", ["-lc", command], { windowsHide: true });
}

function toDataUrl(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function createDesktopCaptureWorkspace() {
  const baseDir = await mkdtemp(join(tmpdir(), "cua-desktop-capture-"));
  const filePath = join(baseDir, `capture-${Date.now()}.png`);
  return { baseDir, filePath };
}

function buildWindowsCaptureScript(imagePath: string) {
  const quotedPath = quotePowerShellSingleQuoted(imagePath);
  return [
    "Add-Type -AssemblyName System.Drawing;",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
    "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap);",
    "$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size);",
    ` $bitmap.Save(${quotedPath}, [System.Drawing.Imaging.ImageFormat]::Png);`.trim(),
    " $graphics.Dispose();",
    " $bitmap.Dispose();",
    "Write-Output ('WIDTH=' + $bounds.Width);",
    "Write-Output ('HEIGHT=' + $bounds.Height);",
  ].join(" ");
}

function buildWindowsWindowListScript() {
  return [
    "Add-Type -AssemblyName Microsoft.VisualBasic;",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class DesktopNative {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    "}",
    "'@;",
    "$foreground = [DesktopNative]::GetForegroundWindow();",
    "$windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Sort-Object ProcessName, Id | ForEach-Object -Begin { $index = 0 } -Process {",
    "  $window = [pscustomobject]@{",
    "    active = ([IntPtr]$_.MainWindowHandle -eq $foreground);",
    "    backend = 'windows-powershell';",
    "    handle = [int64]$_.MainWindowHandle;",
    "    height = $null;",
    "    index = $index;",
    "    platform = 'win32';",
    "    processId = $_.Id;",
    "    processName = $_.ProcessName;",
    "    transport = 'powershell-get-process';",
    "    width = $null;",
    "    windowTitle = $_.MainWindowTitle;",
    "    x = $null;",
    "    y = $null;",
    "  };",
    "  $index = $index + 1;",
    "  $window;",
    "});",
    "$windows | ConvertTo-Json -Compress -Depth 4;",
  ].join(" ");
}

function buildWindowsFocusWindowScript(query: string, match: DesktopWindowMatchMode, index: number) {
  const queryLiteral = quotePowerShellSingleQuoted(query);
  const matchLiteral = quotePowerShellSingleQuoted(match);
  const indexLiteral = Math.max(0, Math.trunc(index));

  return [
    "Add-Type -AssemblyName Microsoft.VisualBasic;",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class DesktopNative {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    "}",
    "'@;",
    `$query = ${queryLiteral};`,
    `$match = ${matchLiteral};`,
    `$index = ${indexLiteral};`,
    "$pattern = [regex]::Escape($query);",
    "$windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Where-Object {",
    "  switch ($match) {",
    "    'process' { $_.ProcessName -match $pattern }",
    "    'title' { $_.MainWindowTitle -match $pattern }",
    "    default { $_.MainWindowTitle -match $pattern -or $_.ProcessName -match $pattern }",
    "  }",
    "} | Sort-Object ProcessName, Id);",
    "if ($windows.Count -eq 0) { throw 'No matching desktop window found.' }",
    "$target = $windows[[Math]::Min($index, $windows.Count - 1)];",
    "[void][Microsoft.VisualBasic.Interaction]::AppActivate($target.Id);",
    "[void][DesktopNative]::ShowWindowAsync($target.MainWindowHandle, 9);",
    "[void][DesktopNative]::SetForegroundWindow($target.MainWindowHandle);",
    "$foreground = [DesktopNative]::GetForegroundWindow();",
    "$result = [pscustomobject]@{",
    "  active = ([IntPtr]$target.MainWindowHandle -eq $foreground);",
    "  backend = 'windows-powershell';",
    "  handle = [int64]$target.MainWindowHandle;",
    "  index = $index;",
    "  platform = 'win32';",
    "  processId = $target.Id;",
    "  processName = $target.ProcessName;",
    "  transport = 'powershell-appactivate';",
    "  windowTitle = $target.MainWindowTitle;",
    "};",
    "$result | ConvertTo-Json -Compress -Depth 4;",
  ].join(" ");
}
function buildLinuxCaptureCommand(imagePath: string) {
  const quoted = quoteShellSingleQuoted(imagePath);
  return [
    `if command -v gnome-screenshot >/dev/null 2>&1; then gnome-screenshot -f ${quoted};`,
    `elif command -v screencapture >/dev/null 2>&1; then screencapture -x ${quoted};`,
    `elif command -v scrot >/dev/null 2>&1; then scrot ${quoted};`,
    `elif command -v import >/dev/null 2>&1; then import -window root ${quoted};`,
    `else exit 127; fi`,
  ].join(' ');
}

export async function captureDesktopScreen() {
  ensureDesktopControlEnabled();
  const { baseDir, filePath } = await createDesktopCaptureWorkspace();

  try {
    if (isWindows()) {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', buildWindowsCaptureScript(filePath)],
        { windowsHide: true },
      );
      const lines = parseKeyValueLines(String(stdout ?? ''));
      const imageBuffer = await readFile(filePath);

      return {
        bytes: imageBuffer.byteLength,
        height: Number(lines.HEIGHT || '0') || undefined,
        imageUrl: toDataUrl(imageBuffer),
        platform: process.platform,
        success: true,
        transport: 'powershell-gdi-copyfromscreen',
        width: Number(lines.WIDTH || '0') || undefined,
      } satisfies DesktopScreenCaptureResult;
    }

    if (isMac()) {
      await execFileAsync('screencapture', ['-x', filePath], { windowsHide: true });
      const imageBuffer = await readFile(filePath);
      return {
        bytes: imageBuffer.byteLength,
        imageUrl: toDataUrl(imageBuffer),
        platform: process.platform,
        success: true,
        transport: 'screencapture',
      } satisfies DesktopScreenCaptureResult;
    }

    if (isLinux()) {
      await runLinuxShell(buildLinuxCaptureCommand(filePath));
      const imageBuffer = await readFile(filePath);
      return {
        bytes: imageBuffer.byteLength,
        imageUrl: toDataUrl(imageBuffer),
        platform: process.platform,
        success: true,
        transport: 'linux-screen-capture',
      } satisfies DesktopScreenCaptureResult;
    }

    throw new RunnerCoreError(
      'Screen capture is not supported on this desktop backend yet.',
      {
        code: 'desktop_screen_capture_not_supported',
        hint:
          'Use the browser computer tool or run the project on Windows/Linux/macOS with a native desktop automation backend.',
        statusCode: 400,
      },
    );
  } catch (error) {
    const failure = error as { message?: string };
    throw new RunnerCoreError('Failed to capture the desktop screen.', {
      code: 'desktop_screen_capture_unavailable',
      hint:
        failure.message ??
        'Install a capture backend such as gnome-screenshot, scrot, import, or the built-in OS screen capture tools.',
      statusCode: 400,
    });
  } finally {
    await rm(baseDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function ensureDesktopControlEnabled() {
  if (!shouldEnableDesktopControl()) {
    throw new RunnerCoreError(
      "Desktop control is disabled in this run environment.",
      {
        code: "desktop_control_disabled",
        hint: "Set CUA_ENABLE_DESKTOP_CONTROL=true to allow native desktop actions.",
        statusCode: 400,
      },
    );
  }
}

async function delayMs(durationMs: number, signal?: AbortSignal) {
  const waitMs = Math.max(0, Math.trunc(durationMs));

  if (waitMs === 0) {
    return;
  }

  if (signal?.aborted) {
    throw new RunnerCoreError("Run aborted.", {
      code: "run_aborted",
      hint: "The operator cancelled the run before the desktop sequence could finish.",
      statusCode: 499,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new RunnerCoreError("Run aborted.", {
          code: "run_aborted",
          hint: "The operator cancelled the run before the desktop sequence could finish.",
          statusCode: 499,
        }),
      );
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
export async function captureDesktopContextSnapshot() {
  const backend = describeDesktopControlBackend();
  const snapshot: DesktopContextSnapshot = {
    backend: backend.backend,
    capturedAt: new Date().toISOString(),
    errors: [],
    platform: process.platform,
  };

  try {
    snapshot.windowState = await getDesktopWindowState();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    snapshot.errors.push({
      code: failure.code ?? "desktop_window_state_unavailable",
      message: failure.message ?? "Unable to inspect the current window state.",
      source: "windowState",
    });
  }

  try {
    snapshot.windows = await listDesktopWindows();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    snapshot.errors.push({
      code: failure.code ?? "desktop_window_list_unavailable",
      message: failure.message ?? "Unable to enumerate desktop windows.",
      source: "windows",
    });
  }

  try {
    snapshot.clipboard = await readDesktopClipboardText();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    snapshot.errors.push({
      code: failure.code ?? "desktop_clipboard_unavailable",
      message: failure.message ?? "Unable to read the clipboard.",
      source: "clipboard",
    });
  }

  try {
    snapshot.screen = await captureDesktopScreen();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    snapshot.errors.push({
      code: failure.code ?? "desktop_screen_capture_unavailable",
      message: failure.message ?? "Unable to capture the desktop screen.",
      source: "screen",
    });
  }

  return snapshot;
}


export async function readDesktopClipboardText() {
  ensureDesktopControlEnabled();

  if (isWindows()) {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$value = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($null -eq $value) { $value = '' }; Write-Output $value",
      ],
      { windowsHide: true },
    );

    return {
      platform: process.platform,
      success: true,
      text: String(stdout ?? "").replace(/\r?\n$/, ""),
      transport: "powershell-get-clipboard",
    } satisfies DesktopClipboardResult;
  }

  if (isMac()) {
    const result = await execFileAsync("pbpaste", [], { windowsHide: true }).catch(
      () => ({ stdout: "" } as { stdout: string }),
    );

    return {
      platform: process.platform,
      success: true,
      text: String(result.stdout ?? ""),
      transport: "pbpaste",
    } satisfies DesktopClipboardResult;
  }

  if (isLinux()) {
    try {
      const { stdout } = await runLinuxShell(
        "if command -v wl-paste >/dev/null 2>&1; then wl-paste --no-newline; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -o; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --output; else exit 127; fi",
      );

      return {
        platform: process.platform,
        success: true,
        text: String(stdout ?? ""),
        transport: "linux-clipboard-reader",
      } satisfies DesktopClipboardResult;
    } catch {
      throw new RunnerCoreError(
        "Linux clipboard access requires wl-paste, xclip, or xsel.",
        {
          code: "desktop_clipboard_unavailable",
          hint:
            "Install wl-clipboard, xclip, or xsel, or run the project on Windows/macOS where native clipboard support is built in.",
          statusCode: 400,
        },
      );
    }
  }

  throw new RunnerCoreError(
    "Clipboard access is not supported on this desktop backend yet.",
    {
      code: "desktop_clipboard_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux/macOS with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function writeDesktopClipboardText(text: string) {
  ensureDesktopControlEnabled();
  const payload = text ?? "";

  if (isWindows()) {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-Command", `Set-Clipboard -Value ${quotePowerShellSingleQuoted(payload)}`],
      { windowsHide: true },
    );

    return {
      platform: process.platform,
      success: true,
      text: payload,
      transport: "powershell-set-clipboard",
    } satisfies DesktopClipboardResult;
  }

  if (isMac()) {
    await runLinuxShell(
      `payload=${quoteShellSingleQuoted(payload)}; printf %s "$payload" | pbcopy`,
    );

    return {
      platform: process.platform,
      success: true,
      text: payload,
      transport: "pbcopy",
    } satisfies DesktopClipboardResult;
  }

  if (isLinux()) {
    try {
      await runLinuxShell(
        `payload=${quoteShellSingleQuoted(payload)}; if command -v wl-copy >/dev/null 2>&1; then printf %s "$payload" | wl-copy; elif command -v xclip >/dev/null 2>&1; then printf %s "$payload" | xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then printf %s "$payload" | xsel --clipboard --input; else exit 127; fi`,
      );

      return {
        platform: process.platform,
        success: true,
        text: payload,
        transport: "linux-clipboard-writer",
      } satisfies DesktopClipboardResult;
    } catch {
      throw new RunnerCoreError(
        "Linux clipboard access requires wl-copy, xclip, or xsel.",
        {
          code: "desktop_clipboard_unavailable",
          hint:
            "Install wl-clipboard, xclip, or xsel, or run the project on Windows/macOS where native clipboard support is built in.",
          statusCode: 400,
        },
      );
    }
  }

  throw new RunnerCoreError(
    "Clipboard access is not supported on this desktop backend yet.",
    {
      code: "desktop_clipboard_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux/macOS with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function getDesktopWindowState() {
  ensureDesktopControlEnabled();
  const backend = describeDesktopControlBackend();

  if (isWindows()) {
    const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
'@;
$hwnd = [DesktopNative]::GetForegroundWindow();
$length = [DesktopNative]::GetWindowTextLength($hwnd);
$builder = New-Object System.Text.StringBuilder ($length + 1);
[DesktopNative]::GetWindowText($hwnd, $builder, $builder.Capacity) | Out-Null;
[uint32]$pid = 0;
[DesktopNative]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null;
$process = Get-Process -Id $pid -ErrorAction SilentlyContinue;
$processName = if ($process) { $process.ProcessName } else { '' };
Write-Output ('WINDOW_TITLE=' + $builder.ToString());
Write-Output ('PROCESS_NAME=' + $processName);
Write-Output ('PROCESS_ID=' + $pid);
Write-Output ('SCREEN_WIDTH=' + [DesktopNative]::GetSystemMetrics(0));
Write-Output ('SCREEN_HEIGHT=' + [DesktopNative]::GetSystemMetrics(1));
`.trim();

    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-Command", script],
      { windowsHide: true },
    );
    const lines = parseKeyValueLines(String(stdout ?? ""));

    return {
      backend: backend.backend,
      platform: process.platform,
      processId: Number(lines.PROCESS_ID || "0") || undefined,
      processName: lines.PROCESS_NAME || undefined,
      screenHeight: Number(lines.SCREEN_HEIGHT || "0") || undefined,
      screenWidth: Number(lines.SCREEN_WIDTH || "0") || undefined,
      transport: "powershell-foreground-window",
      windowTitle: lines.WINDOW_TITLE || undefined,
    } satisfies DesktopWindowState;
  }

  if (isMac()) {
    const script = [
      'tell application "System Events" to set frontApp to name of first application process whose frontmost is true',
      'set frontWindowTitle to ""',
      'try',
      '  tell application (path to frontmost application as text)',
      '    if (count of windows) > 0 then set frontWindowTitle to name of front window',
      '  end tell',
      'end try',
      'return "ACTIVE_APP=" & frontApp & linefeed & "WINDOW_TITLE=" & frontWindowTitle',
    ].join("\n");

    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      windowsHide: true,
    });
    const lines = parseKeyValueLines(String(stdout ?? ""));

    return {
      backend: backend.backend,
      platform: process.platform,
      processName: lines.ACTIVE_APP || undefined,
      transport: "osascript-frontmost-app",
      windowTitle: lines.WINDOW_TITLE || undefined,
    } satisfies DesktopWindowState;
  }

  if (isLinux()) {
    try {
      const { stdout } = await runLinuxShell(`
window_id="$(xdotool getactivewindow 2>/dev/null || true)"
window_title="$(xdotool getactivewindow getwindowname 2>/dev/null || true)"
window_pid="$(xdotool getactivewindow getwindowpid 2>/dev/null || true)"
process_name=""
if [ -n "$window_pid" ]; then
  process_name="$(ps -p "$window_pid" -o comm= 2>/dev/null | head -n 1 | tr -d '\n')"
fi
printf 'WINDOW_ID=%s\n' "\${window_id:-}"
printf 'WINDOW_TITLE=%s\n' "\${window_title:-}"
printf 'PROCESS_ID=%s\n' "\${window_pid:-}"
printf 'PROCESS_NAME=%s\n' "\${process_name:-}"
`.trim());
      const lines = parseKeyValueLines(String(stdout ?? ""));

      return {
        backend: backend.backend,
        platform: process.platform,
        processId: Number(lines.PROCESS_ID || "0") || undefined,
        processName: lines.PROCESS_NAME || undefined,
        transport: "xdotool-active-window",
        windowTitle: lines.WINDOW_TITLE || undefined,
      } satisfies DesktopWindowState;
    } catch {
      throw new RunnerCoreError(
        "Linux window state inspection requires xdotool.",
        {
          code: "desktop_window_state_unavailable",
          hint:
            "Install xdotool, or run the project on Windows/macOS where the native window probe is built in.",
          statusCode: 400,
        },
      );
    }
  }

  throw new RunnerCoreError(
    "Window state inspection is not supported on this desktop backend yet.",
    {
      code: "desktop_window_state_not_supported",
      hint:
        "Use the browser computer tool or run the project on Windows/Linux/macOS with a native desktop automation backend.",
      statusCode: 400,
    },
  );
}

export async function listDesktopWindows() {
  ensureDesktopControlEnabled();
  const backend = describeDesktopControlBackend();

  if (!isWindows()) {
    throw new RunnerCoreError(
      "Window listing is currently implemented for Windows desktop control in this sample.",
      {
        code: "desktop_window_list_not_supported",
        hint:
          "Run the project on Windows to enumerate and focus desktop windows, or extend the Linux/macOS backends later.",
        statusCode: 400,
      },
    );
  }

  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-Command", buildWindowsWindowListScript()],
    { windowsHide: true },
  );

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(String(stdout ?? "[]") || "[]");
  } catch {
    parsed = [];
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? [parsed]
      : [];

  return items.map((item, index) => {
    const entry = item as Record<string, unknown>;
    return {
      active: Boolean(entry.active),
      backend: backend.backend,
      handle: Number(entry.handle ?? 0) || undefined,
      height: Number(entry.height ?? 0) || undefined,
      index: Number(entry.index ?? index) || index,
      platform: process.platform,
      processId: Number(entry.processId ?? 0) || undefined,
      processName: typeof entry.processName === "string" ? entry.processName : undefined,
      transport: typeof entry.transport === "string" ? entry.transport : "powershell-get-process",
      width: Number(entry.width ?? 0) || undefined,
      windowTitle: typeof entry.windowTitle === "string" ? entry.windowTitle : undefined,
      x: Number(entry.x ?? 0) || undefined,
      y: Number(entry.y ?? 0) || undefined,
    } satisfies DesktopWindowEntry;
  });
}

export async function focusDesktopWindow(
  query: string,
  match: DesktopWindowMatchMode = "any",
  index = 0,
) {
  ensureDesktopControlEnabled();
  const backend = describeDesktopControlBackend();
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new RunnerCoreError("Desktop window query cannot be empty.", {
      code: "empty_desktop_window_query",
      hint: "Provide a title or process-name fragment to focus.",
      statusCode: 400,
    });
  }

  if (!isWindows()) {
    throw new RunnerCoreError(
      "Window focusing is currently implemented for Windows desktop control in this sample.",
      {
        code: "desktop_window_focus_not_supported",
        hint:
          "Run the project on Windows to focus desktop windows, or extend the Linux/macOS backends later.",
        statusCode: 400,
      },
    );
  }

  const { stdout } = await execFileAsync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      buildWindowsFocusWindowScript(trimmedQuery, match, index),
    ],
    { windowsHide: true },
  );

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(String(stdout ?? "{}") || "{}");
  } catch {
    parsed = {};
  }

  return {
    active: Boolean(parsed.active),
    backend: backend.backend,
    handle: Number(parsed.handle ?? 0) || undefined,
    index: Number(parsed.index ?? index) || index,
    platform: process.platform,
    processId: Number(parsed.processId ?? 0) || undefined,
    processName: typeof parsed.processName === "string" ? parsed.processName : undefined,
    transport: typeof parsed.transport === "string" ? parsed.transport : "powershell-appactivate",
    windowTitle: typeof parsed.windowTitle === "string" ? parsed.windowTitle : undefined,
  } satisfies DesktopWindowEntry;
}

export async function runDesktopActionSequence(
  workspacePath: string,
  steps: DesktopSequenceStep[],
  signal?: AbortSignal,
) {
  ensureDesktopControlEnabled();
  const backend = describeDesktopControlBackend();
  const normalizedSteps = Array.isArray(steps) ? steps : [];

  if (normalizedSteps.length === 0) {
    throw new RunnerCoreError("Desktop action sequence cannot be empty.", {
      code: "empty_desktop_sequence",
      hint: "Provide at least one step such as open_target, click_point, or type_text.",
      statusCode: 400,
    });
  }

  const trace: DesktopSequenceTraceItem[] = [];
  let windowState: DesktopWindowState | undefined;

  for (let index = 0; index < normalizedSteps.length; index += 1) {
    if (signal?.aborted) {
      throw new RunnerCoreError("Run aborted.", {
        code: "run_aborted",
        hint: "The operator cancelled the run before the desktop sequence could finish.",
        statusCode: 499,
      });
    }

    const step = normalizedSteps[index];
    const type = step?.type;

    if (!type) {
      trace.push({
        error: "Missing step type.",
        index,
        success: false,
        type: "wait",
      });
      return {
        backend: backend.backend,
        completedSteps: index,
        failedStepIndex: index,
        failedStepType: "wait",
        platform: process.platform,
        success: false,
        trace,
        windowState,
      } satisfies DesktopSequenceResult;
    }

    try {
      let result: unknown;

      switch (type) {
        case "open_target":
          result = await openDesktopTarget(workspacePath, String(step.target ?? ""), step.kind);
          break;
        case "move_pointer":
          result = await moveDesktopPointer(Number(step.x ?? 0), Number(step.y ?? 0));
          break;
        case "click_point":
          result = await clickDesktopPoint(
            Number(step.x ?? 0),
            Number(step.y ?? 0),
            step.button,
            Math.max(1, Math.trunc(Number(step.clicks ?? 1))),
          );
          break;
        case "drag_path":
          result = await dragDesktopPath(
            Array.isArray(step.path)
              ? step.path.map((point) => normalizeDesktopPoint(point))
              : [],
            step.button,
          );
          break;
        case "type_text":
          result = await typeDesktopText(String(step.text ?? ""));
          break;
        case "scroll_wheel":
          result = await scrollDesktopWheel(
            Number(step.deltaX ?? 0),
            Number(step.deltaY ?? 0),
            Number(step.x ?? 0),
            Number(step.y ?? 0),
          );
          break;
        case "press_keys":
          result = await pressDesktopKeys(
            Array.isArray(step.keys) ? step.keys.map((key) => String(key)) : [],
          );
          break;
        case "read_clipboard":
          result = await readDesktopClipboardText();
          break;
        case "write_clipboard":
          result = await writeDesktopClipboardText(String(step.text ?? ""));
          break;
        case "get_window_state":
          windowState = await getDesktopWindowState();
          result = windowState;
          break;
        case "snapshot":
          result = await buildDesktopContextSnapshot();
          break;
        case "list_windows":
          result = await listDesktopWindows();
          break;
        case "focus_window":
          result = await focusDesktopWindow(
            String(step.query ?? ""),
            (step.match ?? "any") as DesktopWindowMatchMode,
            Math.trunc(Number(step.index ?? 0)),
          );
          break;
        case "wait":
          await delayMs(Number(step.waitMs ?? 0), signal);
          result = {
            waitedMs: Math.max(0, Math.trunc(Number(step.waitMs ?? 0))),
          };
          break;
        default:
          throw new RunnerCoreError(`Unsupported desktop sequence step: ${type}`, {
            code: "desktop_sequence_unsupported_step",
            hint: "Use only the published desktop step types.",
            statusCode: 400,
          });
      }

      trace.push({
        index,
        note: step.note,
        result,
        success: true,
        type,
      });
    } catch (error) {
      const failure = error as Error;
      trace.push({
        error: failure.message,
        index,
        note: step.note,
        success: false,
        type,
      });

      return {
        backend: backend.backend,
        completedSteps: index,
        contextSnapshot: await buildDesktopContextSnapshot().catch(() => undefined),
        failedStepIndex: index,
        failedStepType: type,
        platform: process.platform,
        success: false,
        trace,
        windowState,
      } satisfies DesktopSequenceResult;
    }
  }

  return {
    backend: backend.backend,
    completedSteps: normalizedSteps.length,
    contextSnapshot: await buildDesktopContextSnapshot().catch(() => undefined),
    platform: process.platform,
    success: true,
    trace,
    windowState,
  } satisfies DesktopSequenceResult;
}
