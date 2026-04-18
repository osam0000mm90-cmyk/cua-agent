import { type BrowserSession } from "@cua-sample/browser-runtime";

export function buildDesktopRunnerPrompt(prompt: string) {
  return prompt.trim();
}

export function buildDesktopCodeInstructions(currentUrl: string) {
  return [
    "You are operating a full desktop-control agent for a ChatGPT-managed computer.",
    "Use workspace_run_terminal, desktop_capture_screen, desktop_context_snapshot, desktop_focus_window, desktop_list_windows, desktop_run_sequence, and the other desktop tools as your primary interface.",
    `The lightweight control page is already open at ${currentUrl}. Treat it as a status surface, not the main task target.`,
    "Use the browser only when the task specifically needs a browser surface.",
    "Prefer terminal commands, desktop pointer and keyboard actions, and window management for host-machine work.",
    "Verify the result with a fresh desktop snapshot or screen capture before you claim success.",
    "Reply briefly once the requested task is complete.",
  ].join("\n");
}

export async function assertDesktopOutcome(session: BrowserSession) {
  await session.page.waitForFunction(() => {
    const scope = globalThis as unknown as { __desktopLabReady?: boolean };
    return scope.__desktopLabReady === true;
  });

  const statusText = await session.page
    .locator("[data-testid='desktop-console-status']")
    .textContent();

  if (!statusText?.toLowerCase().includes("ready")) {
    throw new Error(
      "Desktop console verification failed. The control page did not report ready.",
    );
  }
}
