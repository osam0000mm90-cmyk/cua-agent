import type {
  AgentCapabilityManifest,
  ResponseTurnBudget,
  RunEventLevel,
  ScenarioManifest,
} from "@cua-sample/replay-schema";

export type OperatorConsoleProps = {
  initialRunnerIssue: RunnerIssue | null;
  runnerBaseUrl: string;
  scenarios: ScenarioManifest[];
};

export type LogEntry = {
  createdAt: string;
  detail: string;
  event: string;
  level: RunEventLevel;
  key: string;
  time: string;
};

export type TranscriptEntry = {
  body: string;
  createdAt: string;
  key: string;
  lane: "control" | "operator" | "verification" | "assistant";
  speaker: string;
  time: string;
};

export type ChatMessage = {
  body: string;
  createdAt: string;
  key: string;
  lane: "control" | "operator" | "assistant";
  speaker: string;
  time: string;
};

export type CapabilityManifest = AgentCapabilityManifest;

export type ActivityItem = {
  code?: string;
  createdAt: string;
  detail?: string;
  family: "action" | "observe" | "operator" | "snapshot" | "system" | "tool" | "verify";
  headline: string;
  key: string;
  level: RunEventLevel;
  screenshotId?: string;
  summary: string;
  time: string;
};

export type PendingAction = "reset" | "start" | "stop" | null;

export type RunnerIssue = {
  code: string;
  error: string;
  hint?: string;
  title: string;
};

export type ActionButtonsProps = {
  onResetWorkspace: () => Promise<void>;
  onStartRun: () => Promise<void>;
  onStopRun: () => Promise<void>;
  pendingAction: PendingAction;
  resetDisabled: boolean;
  startDisabled: boolean;
  stopDisabled: boolean;
};

export type RunDefaults = {
  defaultMaxResponseTurns: ResponseTurnBudget;
  defaultRunModel: string;
};
