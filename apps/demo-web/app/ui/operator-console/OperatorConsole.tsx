"use client";

import { useState } from "react";

import { formatClock, formatRunnerIssueMessage, scenarioTargetDisplay } from "./helpers";
import { ChatPanel } from "./ChatPanel";
import { RunControls, RunActionButtons } from "./RunControls";
import { ConsoleTopbar, RunSummary } from "./RunSummary";
import type { OperatorConsoleProps } from "./types";
import { useRunStream } from "./useRunStream";

export function OperatorConsole({
  initialRunnerIssue,
  runnerBaseUrl,
  scenarios,
}: OperatorConsoleProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const {
    browserMode,
    controlsLocked,
    capabilityManifest,
    currentIssue,
    handleOpenReplay,
    handleResetWorkspace,
    handleScenarioChange,
    handleStartRun,
    handleStopRun,
    manualTranscript,
    matchingWorkspaceState,
    maxResponseTurns,
    mode,
    pendingAction,
    prompt,
    runnerOnline,
    screenshots,
    selectedBrowser,
    selectedRun,
    selectedScenario,
    selectedScenarioId,
    selectedScreenshot,
    setBrowserMode,
    setMaxResponseTurns,
    setMode,
    setPrompt,
    setVerificationEnabled,
    verificationEnabled,
  } = useRunStream({
    initialRunnerIssue,
    runnerBaseUrl,
    scenarios,
  });

  const selectedScenarioTitle = selectedScenario?.title ?? "Selected app";
  const stageUrl =
    selectedBrowser?.currentUrl ??
    (selectedRun ? scenarioTargetDisplay(selectedScenario) : "Awaiting app launch");
  const startDisabled =
    !runnerOnline ||
    !selectedScenario ||
    pendingAction !== null ||
    controlsLocked ||
    prompt.trim().length === 0;
  const stopDisabled =
    !selectedRun ||
    selectedRun.run.status !== "running" ||
    pendingAction !== null;
  const resetDisabled = !runnerOnline || !selectedScenario || pendingAction === "start";
  const replayDisabled = !selectedRun;
  const issueMessage = currentIssue ? formatRunnerIssueMessage(currentIssue) : null;
  const stageHeadline = selectedRun
    ? selectedRun.run.status === "running"
      ? "Run active"
      : selectedRun.run.status === "completed"
        ? "Run completed"
        : selectedRun.run.status === "cancelled"
          ? "Run cancelled"
          : currentIssue?.title ?? "Run failed"
    : matchingWorkspaceState
      ? "Workspace ready"
      : currentIssue
        ? currentIssue.title
        : runnerOnline
          ? "Ready to work"
          : "Runner offline";
  const stageSupportCopy = selectedRun
    ? selectedRun.run.status === "failed"
      ? issueMessage
      : null
    : matchingWorkspaceState
      ? `Mutable workspace copied to ${matchingWorkspaceState.workspacePath} at ${formatClock(
          matchingWorkspaceState.resetAt,
        )}.`
      : currentIssue
        ? issueMessage
        : runnerOnline
          ? "Describe what you want in plain language and the assistant will execute it through the connected runner."
          : issueMessage;
  const topbarSubtitle = selectedRun
    ? `Reviewing ${selectedScenarioTitle}`
    : "Natural-language chat on top, live execution underneath.";
  const latestScreenshot = screenshots.at(-1) ?? null;
  const visibleScreenshot = selectedScreenshot ?? latestScreenshot;
  const visibleScreenshotIndex = visibleScreenshot
    ? screenshots.findIndex((screenshot) => screenshot.id === visibleScreenshot.id)
    : -1;

  return (
    <main className="consoleShell">
      <section className="consoleFrame">
        <ConsoleTopbar runnerOnline={runnerOnline} topbarSubtitle={topbarSubtitle} />

        <div className="workspaceGrid">
          <section className="mainColumn">
            <ChatPanel
              controlsLocked={controlsLocked}
              onPromptChange={setPrompt}
              onPromptSubmit={handleStartRun}
              prompt={prompt}
              startDisabled={startDisabled}
              transcript={manualTranscript}
            />
          </section>

          <aside className="sideColumn">
            <RunSummary stageHeadline={stageHeadline} stageSupportCopy={stageSupportCopy} />
            <RunActionButtons
              onResetWorkspace={handleResetWorkspace}
              onStartRun={handleStartRun}
              onStopRun={handleStopRun}
              pendingAction={pendingAction}
              resetDisabled={resetDisabled}
              startDisabled={startDisabled}
              stopDisabled={stopDisabled}
            />

            <div className="statusPanel">
              <div className="stageChrome">
                <div className="stageUrl">{stageUrl}</div>
              </div>
              <div className="statusMetaRow">
                <span className="readoutChip">
                  {selectedRun ? selectedRun.run.status : "idle"}
                </span>
                <span className="readoutChip">
                  {selectedScenario ? selectedScenario.category : "—"}
                </span>
                <span className="readoutChip">
                  {screenshots.length} frame{screenshots.length === 1 ? "" : "s"}
                </span>
              </div>
            </div>

            <div className="previewCard">
              <div className="panelHeader compactHeader">
                <div>
                  <p className="eyebrow">Latest frame</p>
                  <h2>Evidence</h2>
                </div>
                <button
                  className="secondaryButton"
                  disabled={replayDisabled}
                  onClick={handleOpenReplay}
                  type="button"
                >
                  Replay JSON
                </button>
              </div>

              {visibleScreenshot ? (
                <>
                  {/* Replay frames come from the runner's artifact endpoint. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={`Captured frame ${visibleScreenshotIndex + 1} for ${selectedScenarioTitle}`}
                    className="previewImage"
                    decoding="async"
                    loading="lazy"
                    src={`${runnerBaseUrl}${visibleScreenshot.url}`}
                  />
                  <div className="previewMeta">
                    <span className="readoutChip">
                      {visibleScreenshot.pageTitle?.trim() || visibleScreenshot.label}
                    </span>
                    <span className="readoutChip">
                      {formatClock(visibleScreenshot.capturedAt)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="emptyState compactEmpty">
                  <strong>No capture yet</strong>
                  <span>The assistant will surface browser evidence here as soon as the run produces it.</span>
                </div>
              )}
            </div>

            <details className="advancedPanel" open={showDiagnostics} onToggle={(event) => setShowDiagnostics(event.currentTarget.open)}>
              <summary>
                <span className="advancedSummaryCopy">
                  <span className="advancedLabel">Diagnostics</span>
                  <span className="advancedHint">Settings, capabilities, and run actions</span>
                </span>
              </summary>

              <div className="advancedContent">
                <RunControls
                  browserMode={browserMode}
                  capabilityManifest={capabilityManifest}
                  controlsLocked={controlsLocked}
                  maxResponseTurns={maxResponseTurns}
                  mode={mode}
                  onBrowserModeChange={setBrowserMode}
                  onMaxResponseTurnsChange={setMaxResponseTurns}
                  onModeChange={setMode}
                  onResetWorkspace={handleResetWorkspace}
                  onScenarioChange={handleScenarioChange}
                  onStartRun={handleStartRun}
                  onStopRun={handleStopRun}
                  onVerificationEnabledChange={setVerificationEnabled}
                  pendingAction={pendingAction}
                  resetDisabled={resetDisabled}
                  scenarios={scenarios}
                  selectedScenarioId={selectedScenarioId}
                  showActionButtons={false}
                  startDisabled={startDisabled}
                  stopDisabled={stopDisabled}
                  verificationEnabled={verificationEnabled}
                />
              </div>
            </details>
          </aside>
        </div>
      </section>
    </main>
  );
}
