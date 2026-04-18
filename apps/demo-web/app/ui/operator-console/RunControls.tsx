"use client";

import type {
  BrowserMode,
  ExecutionMode,
  ResponseTurnBudget,
  ScenarioManifest,
} from "@cua-sample/replay-schema";

import {
  browserHelpText,
  engineHelpText,
  turnBudgetHelpText,
  verificationHelpText,
} from "./helpers";
import type { ActionButtonsProps, CapabilityManifest } from "./types";

type RunControlsProps = ActionButtonsProps & {
  browserMode: BrowserMode;
  controlsLocked: boolean;
  maxResponseTurns: ResponseTurnBudget;
  mode: ExecutionMode;
  onBrowserModeChange: (value: BrowserMode) => void;
  onMaxResponseTurnsChange: (value: ResponseTurnBudget) => void;
  onModeChange: (value: ExecutionMode) => void;
  onScenarioChange: (value: string) => void;
  onVerificationEnabledChange: (value: boolean) => void;
  scenarios: ScenarioManifest[];
  selectedScenarioId: string;
  showActionButtons?: boolean;
  verificationEnabled: boolean;
  capabilityManifest: CapabilityManifest | null;
};

type InfoPopoverProps = {
  id: string;
  label: string;
  text: string;
};

function InfoPopover({ id, label, text }: InfoPopoverProps) {
  return (
    <span className="fieldInfo">
      <button
        aria-describedby={id}
        aria-label={`${label} help`}
        className="fieldInfoButton"
        type="button"
      >
        i
      </button>
      <span className="fieldPopover" id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}

function SegmentControl<T extends string>({
  ariaLabel,
  disabled,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: Array<{ label: string; value: T }>;
  value: T;
}) {
  return (
    <div aria-label={ariaLabel} className="segmentControl" role="tablist">
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={`segmentButton ${value === option.value ? "isActive" : ""}`}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function RunActionButtons({
  onResetWorkspace,
  onStartRun,
  onStopRun,
  pendingAction,
  resetDisabled,
  startDisabled,
  stopDisabled,
}: ActionButtonsProps) {
  return (
    <div className="stageToolbarActions">
      <button
        className="primaryButton"
        disabled={startDisabled}
        onClick={() => void onStartRun()}
        type="button"
      >
        {pendingAction === "start" ? "Starting..." : "Start"}
      </button>
      <button
        className="secondaryButton"
        disabled={stopDisabled}
        onClick={() => void onStopRun()}
        type="button"
      >
        {pendingAction === "stop" ? "Stopping..." : "Stop"}
      </button>
      <button
        className="secondaryButton"
        disabled={resetDisabled}
        onClick={() => void onResetWorkspace()}
        type="button"
      >
        {pendingAction === "reset" ? "Resetting..." : "Reset"}
      </button>
    </div>
  );
}

export function RunControls({
  browserMode,
  controlsLocked,
  maxResponseTurns,
  mode,
  onBrowserModeChange,
  onMaxResponseTurnsChange,
  onModeChange,
  onScenarioChange,
  onVerificationEnabledChange,
  scenarios,
  selectedScenarioId,
  showActionButtons = true,
  verificationEnabled,
  capabilityManifest,
  ...actionButtons
}: RunControlsProps) {
  return (
    <section className="controlsPanel">
      <div className="panelHeader compactHeader">
        <div>
          <p className="eyebrow">Assistant settings</p>
          <h2>Execution controls</h2>
        </div>
        {capabilityManifest ? (
          <div className="capabilityChips" aria-label="Available agent capabilities">
            {capabilityManifest.capabilities.slice(0, 4).map((capability) => (
              <span className="readoutChip" key={capability.name}>
                {capability.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="controlsGrid compactGrid">
        <div className="railField scenarioField">
          <label htmlFor="scenario-select">Scenario</label>
          <select
            disabled={controlsLocked}
            id="scenario-select"
            onChange={(event) => onScenarioChange(event.target.value)}
            value={selectedScenarioId}
          >
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.title}
              </option>
            ))}
          </select>
        </div>

        <div className="railField">
          <div className="fieldLabel">
            <span>Engine</span>
            <InfoPopover id="engine-help-popover" label="Engine" text={engineHelpText} />
          </div>
          <SegmentControl
            ariaLabel="Execution mode"
            disabled={controlsLocked}
            onChange={onModeChange}
            options={[
              { label: "Code", value: "code" },
              { label: "Native", value: "native" },
            ]}
            value={mode}
          />
        </div>

        <div className="railField">
          <div className="fieldLabel">
            <span>Browser</span>
            <InfoPopover id="browser-help-popover" label="Browser" text={browserHelpText} />
          </div>
          <SegmentControl
            ariaLabel="Browser mode"
            disabled={controlsLocked}
            onChange={onBrowserModeChange}
            options={[
              { label: "Headless", value: "headless" },
              { label: "Visible", value: "headful" },
            ]}
            value={browserMode}
          />
        </div>

        <div className="railField budgetField">
          <div className="fieldLabel">
            <label htmlFor="turn-budget">Turn budget</label>
            <InfoPopover
              id="turn-budget-help-popover"
              label="Turn budget"
              text={turnBudgetHelpText}
            />
          </div>
          <div className="budgetControl">
            <input
              disabled={controlsLocked}
              id="turn-budget"
              max={50}
              min={4}
              onChange={(event) =>
                onMaxResponseTurnsChange(Number(event.target.value) as ResponseTurnBudget)
              }
              step={1}
              type="range"
              value={maxResponseTurns}
            />
            <span className="budgetValue">{maxResponseTurns} turns</span>
          </div>
        </div>

        <label className="verificationToggle">
          <input
            checked={verificationEnabled}
            disabled={controlsLocked}
            onChange={(event) => onVerificationEnabledChange(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Verification</strong>
            <small>{verificationHelpText}</small>
          </span>
        </label>
      </div>

      {capabilityManifest ? (
        <details className="advancedPanel">
          <summary>
            <span className="advancedSummaryCopy">
              <span className="advancedLabel">Capabilities</span>
              <span className="advancedHint">Browser, terminal, filesystem, voice, desktop, memory, integration, clipboard, window state, sequences</span>
            </span>
          </summary>
          <div className="advancedContent">
            <div className="capabilityList">
              {capabilityManifest.capabilities.map((capability) => (
                <article className="capabilityCard" key={capability.name}>
                  <strong>{capability.name}</strong>
                  <p>{capability.description}</p>
                </article>
              ))}
            </div>
            <div className="policyBanner">
              <strong>Terminal policy:</strong> {capabilityManifest.terminalPolicy.mode} mode
            </div>
          </div>
        </details>
      ) : null}

      {showActionButtons ? <RunActionButtons {...actionButtons} /> : null}
    </section>
  );
}
