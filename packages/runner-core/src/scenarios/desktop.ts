import { type ExecutionMode } from "@cua-sample/replay-schema";

import { buildDesktopCodeInstructions, buildDesktopRunnerPrompt, assertDesktopOutcome } from "../desktop-plan.js";
import { createDefaultResponsesClient, runResponsesCodeLoop } from "../responses-loop.js";
import {
  failLiveResponsesUnavailable,
  type RunExecutionContext,
  type RunExecutor,
  runWorkspaceLabBrowserFlow,
} from "../scenario-runtime.js";

const liveOnlyMessage =
  "Desktop control runs require the live Responses API code loop. Deterministic fallback is disabled because the agent must reason over real desktop state.";

class DesktopCodeExecutor implements RunExecutor {
  async execute(context: RunExecutionContext) {
    const client = createDefaultResponsesClient();

    if (!client) {
      await failLiveResponsesUnavailable(context, liveOnlyMessage);
      return;
    }

    await context.emitEvent({
      detail: context.detail.run.model,
      level: "ok",
      message: "Using the live Responses API code loop for the desktop control console.",
      type: "run_progress",
    });

    await runWorkspaceLabBrowserFlow(context, {
      assertOutcome: (session) => assertDesktopOutcome(session),
      buildVerificationDetail: async (session) => {
        const state = await session.readState();
        return `url=${state.currentUrl}${state.pageTitle ? ` · title=${state.pageTitle}` : ""}`;
      },
      loadedScreenshotLabel: "desktop-console-loaded",
      navigationMessage: "Desktop control console loaded from the run workspace.",
      runner: async ({ session }) => {
        const result = await runResponsesCodeLoop(
          {
            context,
            instructions: buildDesktopCodeInstructions(session.page.url()),
            maxResponseTurns: context.detail.run.maxResponseTurns ?? 24,
            prompt: buildDesktopRunnerPrompt(context.detail.run.prompt),
            session,
          },
          client,
        );

        return {
          notes: result.notes,
          verificationMessage:
            "Desktop control verification passed after the live Responses code loop.",
        };
      },
      sessionLabel: "desktop control console",
      verifiedScreenshotLabel: "desktop-console-verified",
    });
  }
}

export function createDesktopExecutor(_mode: ExecutionMode): RunExecutor {
  return new DesktopCodeExecutor();
}
