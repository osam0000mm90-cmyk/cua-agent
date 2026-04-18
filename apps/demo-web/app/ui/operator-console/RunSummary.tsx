"use client";

type RunSummaryProps = {
  runnerOnline: boolean;
  topbarSubtitle: string;
};

type StageSummaryProps = {
  stageHeadline: string;
  stageSupportCopy: string | null;
};

export function ConsoleTopbar({ runnerOnline, topbarSubtitle }: RunSummaryProps) {
  return (
    <header className="consoleTopbar">
      <div className="brandBlock">
        <div className="brandMark">
          <span>AI</span>
        </div>
        <div className="brandCopy">
          <p className="eyebrow">Agent workspace</p>
          <h1>Chat-driven computer control</h1>
          <p>{topbarSubtitle}</p>
        </div>
      </div>

      <div className={`statusPill ${runnerOnline ? "ok" : "error"}`}>
        <span className="statusDot" />
        {runnerOnline ? "Runner online" : "Runner offline"}
      </div>
    </header>
  );
}

export function RunSummary({ stageHeadline, stageSupportCopy }: StageSummaryProps) {
  return (
    <div className="runSummaryCard">
      <p className="eyebrow">Live status</p>
      <h3>{stageHeadline}</h3>
      {stageSupportCopy ? <p className="runSummaryText">{stageSupportCopy}</p> : null}
    </div>
  );
}
