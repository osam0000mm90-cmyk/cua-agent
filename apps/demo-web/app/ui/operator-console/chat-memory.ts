"use client";

import type { TranscriptEntry } from "./types";

const storagePrefix = "cua-sample.chat-history.v1";
const maxPersistedEntries = 48;

type StoredConversation = {
  entries: TranscriptEntry[];
  version: 1;
};

function storageKey(scenarioId: string) {
  return `${storagePrefix}:${scenarioId}`;
}

function hasBrowserStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeEntries(entries: TranscriptEntry[]) {
  return entries.slice(-maxPersistedEntries);
}

export function loadStoredTranscript(scenarioId: string) {
  if (!hasBrowserStorage()) {
    return [] as TranscriptEntry[];
  }

  try {
    const raw = window.localStorage.getItem(storageKey(scenarioId));

    if (!raw) {
      return [] as TranscriptEntry[];
    }

    const parsed = JSON.parse(raw) as StoredConversation | TranscriptEntry[];

    if (Array.isArray(parsed)) {
      return normalizeEntries(parsed);
    }

    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return normalizeEntries(parsed.entries);
    }
  } catch {
    // Intentionally ignore invalid persisted data and fall back to a clean chat.
  }

  return [] as TranscriptEntry[];
}

export function saveStoredTranscript(scenarioId: string, entries: TranscriptEntry[]) {
  if (!hasBrowserStorage()) {
    return;
  }

  const payload: StoredConversation = {
    entries: normalizeEntries(entries),
    version: 1,
  };

  try {
    window.localStorage.setItem(storageKey(scenarioId), JSON.stringify(payload));
  } catch {
    // Ignore storage quota and privacy mode failures.
  }
}

export function clearStoredTranscript(scenarioId: string) {
  if (!hasBrowserStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(storageKey(scenarioId));
  } catch {
    // Ignore storage errors.
  }
}

export function transcriptStorageLabel(scenarioTitle: string) {
  return `Saved locally for ${scenarioTitle}`;
}
