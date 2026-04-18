"use client";

import type { FormEvent, KeyboardEvent } from "react";

import type { TranscriptEntry } from "./types";

const suggestions = [
  "Open the desktop console and inspect the latest run.",
  "Summarize the current state in plain language.",
  "Draft the next step I should take and execute it.",
  "Check the workspace for blockers and report them.",
];

type ChatPanelProps = {
  controlsLocked: boolean;
  onPromptChange: (value: string) => void;
  onPromptSubmit: () => Promise<void>;
  prompt: string;
  startDisabled: boolean;
  transcript: TranscriptEntry[];
};

export function ChatPanel({
  controlsLocked,
  onPromptChange,
  onPromptSubmit,
  prompt,
  startDisabled,
  transcript,
}: ChatPanelProps) {
  const visibleTranscript = transcript.filter(
    (entry) => entry.lane === "operator" || entry.lane === "assistant",
  );
  const transcriptToRender: TranscriptEntry[] =
    visibleTranscript.length > 0
      ? visibleTranscript
      : [
          {
            body:
              "Tell me what you want in normal language. I will plan the work, run the tools, and keep you posted here.",
            createdAt: new Date().toISOString(),
            key: "welcome-assistant",
            lane: "assistant",
            speaker: "Assistant",
            time: "Now",
          },
        ];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onPromptSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void onPromptSubmit();
  };

  return (
    <section className="chatPanel" aria-label="Conversation">
      <header className="panelHeader chatHeader">
        <div>
          <p className="eyebrow">Chat first</p>
          <h2>Describe the task in natural language.</h2>
        </div>
        <p className="panelHint">
          You chat normally. The assistant plans the work, uses the tools, and reports the result.
        </p>
      </header>

      <div className="chatTranscript" aria-live="polite">
        {transcriptToRender.map((entry) => {
          const bubbleClass =
            entry.lane === "assistant" ? "bubble assistantBubble" : "bubble userBubble";

          return (
            <article className={bubbleClass} key={entry.key}>
              <div className="bubbleMeta">
                <span>{entry.speaker}</span>
                <time>{entry.time}</time>
              </div>
              <p>{entry.body}</p>
            </article>
          );
        })}
      </div>

      <div className="suggestionRail" aria-label="Suggested prompts">
        {suggestions.map((suggestion) => (
          <button
            className="suggestionChip"
            disabled={controlsLocked}
            key={suggestion}
            onClick={() => onPromptChange(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          disabled={controlsLocked}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the task in natural language. No slash commands needed."
          rows={5}
          value={prompt}
        />
        <div className="composerFooter">
          <p className="composerHint">Enter to send. Shift+Enter for a new line. Commands are optional.</p>
          <button className="primaryButton" disabled={controlsLocked || startDisabled} type="submit">
            Send request
          </button>
        </div>
      </form>
    </section>
  );
}
