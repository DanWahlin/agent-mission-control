import type { CopilotEventSummary } from './missionTypes.js';

export interface ReplayViewState {
  paused: boolean;
  cursor: number;
  total: number;
  atLive: boolean;
}

export interface ReplayIngestInput {
  events: CopilotEventSummary[];
  eventLog: CopilotEventSummary[];
  seenEventKeys: Set<string>;
  cursor: number;
  paused: boolean;
  maxEvents: number;
  includeEvent: (event: CopilotEventSummary) => boolean;
}

export interface ReplayIngestResult {
  appended: CopilotEventSummary[];
  cursor: number;
  wasAtLive: boolean;
}

export interface ReplayAdvanceInput {
  eventLog: CopilotEventSummary[];
  cursor: number;
  paused: boolean;
  playTimer: number;
  playbackInterval: number;
  delta: number;
}

export interface ReplayAdvanceResult {
  cursor: number;
  playTimer: number;
  events: CopilotEventSummary[];
}

export function replayEventKey(event: CopilotEventSummary): string {
  return `${event.timestamp}|${event.session_id}|${event.kind}|${event.tool}|${event.category}|${event.success}`;
}

export function isReplayAtLive(cursor: number, total: number): boolean {
  return cursor >= total;
}

export function createReplayViewState(paused: boolean, cursor: number, total: number): ReplayViewState {
  return {
    paused,
    cursor,
    total,
    atLive: isReplayAtLive(cursor, total),
  };
}

export function ingestReplayEvents(input: ReplayIngestInput): ReplayIngestResult {
  const wasAtLive = isReplayAtLive(input.cursor, input.eventLog.length);
  const appended: CopilotEventSummary[] = [];
  let cursor = input.cursor;

  if (input.events.length > 0) {
    const chronological = [...input.events].reverse();
    for (const event of chronological) {
      if (!input.includeEvent(event)) continue;
      const key = replayEventKey(event);
      if (input.seenEventKeys.has(key)) continue;
      input.seenEventKeys.add(key);
      input.eventLog.push(event);
      appended.push(event);
    }
  }

  if (input.eventLog.length > input.maxEvents) {
    const trim = input.eventLog.length - input.maxEvents;
    const removed = input.eventLog.splice(0, trim);
    for (const event of removed) input.seenEventKeys.delete(replayEventKey(event));
    cursor = Math.max(0, cursor - trim);
  }

  if (appended.length > 0 && wasAtLive && !input.paused) {
    cursor = input.eventLog.length;
  }

  return { appended, cursor, wasAtLive };
}

export function advanceReplayCursor(input: ReplayAdvanceInput): ReplayAdvanceResult {
  if (input.paused || isReplayAtLive(input.cursor, input.eventLog.length)) {
    return { cursor: input.cursor, playTimer: input.playTimer, events: [] };
  }

  let cursor = input.cursor;
  let playTimer = input.playTimer + input.delta;
  const events: CopilotEventSummary[] = [];

  while (playTimer >= input.playbackInterval && !isReplayAtLive(cursor, input.eventLog.length)) {
    playTimer -= input.playbackInterval;
    events.push(input.eventLog[cursor++]);
  }

  if (isReplayAtLive(cursor, input.eventLog.length)) {
    playTimer = 0;
  }

  return { cursor, playTimer, events };
}

export function seekReplayCursor(cursor: number, total: number): number {
  return Math.max(0, Math.min(total, Math.round(cursor)));
}
