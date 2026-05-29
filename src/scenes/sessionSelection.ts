import { errorOrReview } from './opsSignals.js';
import type { CopilotSessionSummary } from './missionTypes.js';

export interface SessionPickerOption {
  session: CopilotSessionSummary;
  index: number;
}

export interface SelectedSessionInput {
  sessions: CopilotSessionSummary[];
  selectedIndex: number;
  userSelectedSession: boolean;
  preferredSessionId?: string | null;
}

export interface SelectedSessionResult {
  session: CopilotSessionSummary | null;
  selectedIndex: number;
  userSelectedSession: boolean;
}

export function pickSelectedSession(input: SelectedSessionInput): SelectedSessionResult {
  const { sessions, preferredSessionId } = input;
  let selectedIndex = input.selectedIndex;
  let userSelectedSession = input.userSelectedSession;

  if (sessions.length === 0) {
    return { session: null, selectedIndex, userSelectedSession };
  }

  const activeSessions = sessions.filter(session => session.is_active);

  // Honor a sticky id from prefs only when it points at a selectable
  // current session. If an old inactive session from the same repo is
  // persisted while new work is active, showing that stale detail card
  // beside a "Running sessions" picker makes Last/Age/Tokens look broken.
  if (userSelectedSession && preferredSessionId) {
    const index = sessions.findIndex(session => session.id === preferredSessionId);
    if (index >= 0 && (activeSessions.length === 0 || sessions[index].is_active)) {
      return { session: sessions[index], selectedIndex: index, userSelectedSession };
    }
    if (index >= 0 && activeSessions.length > 0) {
      userSelectedSession = false;
    }
  }

  const safeIndex = Math.max(0, Math.min(selectedIndex, sessions.length - 1));
  selectedIndex = safeIndex;

  if (!userSelectedSession) {
    const reviewSession = sessions.find(session => session.is_active && errorOrReview(session));
    if (reviewSession) {
      return { session: reviewSession, selectedIndex: sessions.indexOf(reviewSession), userSelectedSession };
    }
  }

  if (sessions[safeIndex]?.is_active || activeSessions.length === 0) {
    return { session: sessions[safeIndex], selectedIndex: safeIndex, userSelectedSession };
  }

  const active = activeSessions[0];
  return { session: active, selectedIndex: sessions.indexOf(active), userSelectedSession };
}

export function sessionPickerOptions(sessions: CopilotSessionSummary[]): SessionPickerOption[] {
  const indexed = sessions.map((session, index) => ({ session, index }));
  const active = indexed.filter(({ session }) => session.is_active);
  const options = active.length > 0 ? active : indexed;
  return options.sort((a, b) => {
    const aReview = errorOrReview(a.session) ? 1 : 0;
    const bReview = errorOrReview(b.session) ? 1 : 0;
    return bReview - aReview || Number(b.session.is_active) - Number(a.session.is_active);
  });
}

export function findSessionIndexById(sessions: CopilotSessionSummary[], id: string): number {
  return sessions.findIndex(session => session.id === id);
}
