declare const Phaser: any;

import { W, H } from './viewport.js';

type MissionCategory = 'forge' | 'library' | 'terminal' | 'signal' | 'delegates' | 'skills' | 'court' | 'mcp' | 'workshop' | 'complete' | 'alert' | 'thinking' | 'waiting' | 'prompt' | 'arrival' | 'activity';

interface CopilotToolMetric {
  name: string;
  category: MissionCategory | string;
  count: number;
}

interface CopilotEventSummary {
  session_id: string;
  timestamp: string;
  kind: string;
  tool: string;
  category: MissionCategory | string;
  success: boolean;
}

interface CopilotSessionSummary {
  id: string;
  title: string;
  repository: string;
  branch: string;
  updated_at: string;
  is_active: boolean;
  status: 'working' | 'thinking' | 'waiting' | 'needs-attention' | 'idle' | string;
  event_count: number;
  tool_count: number;
  write_count: number;
  read_count: number;
  command_count: number;
  web_count: number;
  task_count: number;
  mcp_count?: number;
  error_count: number;
  turn_count?: number;
  output_tokens: number;
  input_tokens?: number;
  last_tool: string;
  last_event_kind?: string;
  last_event_category?: string;
  last_event_timestamp?: string;
  stale_seconds?: number;
  last_model?: string;
  git_root?: string;
  recent_tool_calls?: SessionToolCall[];
  recent_turns?: SessionTurnSummary[];
}

interface SessionToolCall {
  tool: string;
  category: string;
  timestamp: string;
  success: boolean;
  completed_at?: string;
  model?: string;
  call_id?: string;
  turn_id?: string;
  target?: string;
  details?: SafeDetail[];
  duration_ms?: number;
}

interface SafeDetail {
  label: string;
  value: string;
}

interface SessionTurnSummary {
  id: string;
  started_at: string;
  ended_at: string;
  status: 'running' | 'complete' | 'failed' | string;
  tool_count: number;
  tools?: string[];
  failure_count: number;
  categories: string[];
  model?: string;
  output_tokens?: number;
  partial?: boolean;
  duration_ms?: number;
}

interface CopilotActivity {
  available: boolean;
  source: string;
  scanned_sessions: number;
  active_sessions: number;
  total_events: number;
  total_tool_calls: number;
  total_output_tokens: number;
  total_input_tokens?: number;
  total_turns?: number;
  sessions: CopilotSessionSummary[];
  tools: CopilotToolMetric[];
  recent_events: CopilotEventSummary[];
  alerts: string[];
  generated_at_ms: number;
}

interface Quarter {
  key: MissionCategory;
  label: string;
  short: string;
  color: number;
  x: number;
  y: number;
  count: number;
}

interface MissionLayout {
  s: number;
  compact: boolean;
  leftX: number;
  opsY: number;
  opsH: number;
  topY: number;
  panelW: number;
  sessionH: number;
  replayH: number;
  replayY: number;
  bottomH: number;
  bottomY: number;
  inspectorX: number;
  inspectorW: number;
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  quarterR: number;
  quarterSize: number;
  topLift: number;
}

interface EventPulse {
  id: string;
  quarterKey: MissionCategory;
  color: number;
  startX: number;
  startY: number;
  midX: number;
  endX: number;
  endY: number;
  progress: number;
  duration: number;
  delay: number;
  arrived: boolean;
  source: 'live' | 'replay';
}

/// Short-lived expanding ring drawn at a building when a pulse arrives
/// — the "rune lights up" sigil. Lives in the same `flow` Graphics
/// layer as the pulses and is rendered with `ADD` blend so overlapping
/// arrivals (chatty session) brighten naturally instead of stacking
/// flat. Auto-removed once `age >= lifetime`.
interface ArrivalEffect {
  x: number;
  y: number;
  color: number;
  age: number;
  lifetime: number;
}

type AttentionLevel = 'ok' | 'watch' | 'review';

interface InsightCard {
  label: string;
  value: string;
  sub?: string;
  /// Optional shorter fallback sub-line used when `sub` doesn't fit
  /// the card width. Lets the Tokens card show "12m in · 2m out" when
  /// there's room and collapse to "12m/2m" on narrow viewports.
  subCompact?: string;
  color?: string;
}

interface OpsSummary {
  mode: string;
  attention: AttentionLevel;
  recommendation: string;
  reason: string;
}

declare global {
  interface Window {
    __missionControlFixture?: CopilotActivity;
    __missionControlAutoFixture?: boolean;
    __cmcOnAgentActivityChanged?: () => void;
    __cmcSetTheme?: (mode: 'dark' | 'light') => void;
    __cmcUpdateModel?: (model: string) => void;
    __cmcSetPanelsHidden?: (hidden: boolean) => void;
    __cmcRenderDashboard?: (view: unknown) => void;
    __cmcSelectSession?: (id: string) => void;
    __cmcOpenSelectedSessionInEditor?: () => void;
    __cmcToggleReplayPause?: () => void;
    __cmcJumpReplayToLive?: () => void;
    __cmcSeekReplayRatio?: (ratio: number) => void;
  }
}

const SPACE_ATLAS_KEY = 'mc';
const SPACE_ATLAS_ROOT = '../assets/space';

type ThemeMode = 'dark' | 'light';
interface MissionTheme {
  mode: ThemeMode;
  backdropFill: number;
  panelBg: number;
  text: string;
  muted: string;
}

const DARK_THEME: MissionTheme = {
  mode: 'dark',
  backdropFill: 0x05081a,
  panelBg: 0x0a1024,
  text: '#e8ecff',
  muted: '#93a4d8',
};

const LIGHT_THEME: MissionTheme = {
  mode: 'light',
  backdropFill: 0xf4f7fb,
  panelBg: 0xffffff,
  text: '#1f2937',
  muted: '#64748b',
};

let theme: MissionTheme = DARK_THEME;

function setActiveTheme(mode: ThemeMode) {
  theme = mode === 'light' ? LIGHT_THEME : DARK_THEME;
}

function loadInitialThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage?.getItem('cmc_theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* private mode / no storage — fall through */ }
  return 'dark';
}

setActiveTheme(loadInitialThemeMode());
const QUARTER_TEXTURES: Record<string, string> = {
  forge: 'dome_glass_blue',
  library: 'outpost_disc',
  terminal: 'console_wide_teal',
  signal: 'telescope_blue',
  delegates: 'ship_fighter_blue',
  skills: 'satellite_dish_stand',
  court: 'console_sphere',
  mcp: 'satellite_8panel',
};
const CENTER_TEXTURE = 'outpost_domed_island';

/// Single source of truth for quarter hues. Both `buildQuarters` and
/// `categoryColor` read from this map — previously they each had their
/// own hex literals which silently drifted apart whenever one was
/// tweaked. The 'alert' entry is shared with the attention/error pulse
/// path and is intentionally not a quarter.
const QUARTER_COLORS: Record<MissionCategory, number> = {
  forge: 0xf0911d,
  library: 0xe1ae45,
  terminal: 0x86d4b7,
  signal: 0xc37ee8,
  delegates: 0xfc60c7,
  skills: 0xda58e0,
  court: 0x2fc5e8,
  mcp: 0x45cea5,
  alert: 0xff5252,
  // The remaining MissionCategory members are event-kind tags, not
  // visual quarters, so they fall back to the muted default in
  // `categoryColor`. Listing them keeps the Record exhaustive.
  workshop: 0x9aa6c8,
  complete: 0x9aa6c8,
  thinking: 0x9aa6c8,
  waiting: 0x9aa6c8,
  prompt: 0x9aa6c8,
  arrival: 0x9aa6c8,
  activity: 0x9aa6c8,
};

/// Vertical offset (px at 1× scale) applied to the four diagonal
/// quarters so they don't visually crowd the side cardinals (Commands,
/// Intent). Scaled down with the layout in `buildQuarters`.
const DIAGONAL_QUARTER_SHIFT_PX = 22;

/// Minimum hit radius (px) used by `updateHoveredQuarter`. Acts as a
/// floor under `layout.quarterR` so the smallest compact viewport
/// still has a forgiving hover area instead of requiring pixel-perfect
/// targeting on tiny quarter icons.
const QUARTER_HOVER_RADIUS_MIN_PX = 48;

/// Stagger between sequential event pulses fired by `ingestActivityEvents`.
/// Keeps a burst of N events from looking like a single blob — each one
/// gets `i * PULSE_STAGGER_MS` delay so the eye can track the train.
const PULSE_STAGGER_MS = 120;

/// Number of fading samples drawn behind the pulse head to form a
/// glowing comet tail. Each sample is offset along the bezier path by
/// `PULSE_TRAIL_SPACING_PROGRESS`, so the visible trail length is
/// `samples * spacing` of the total journey. 4 × 0.055 ≈ 22% of the
/// path — short enough to read as a tail, long enough to feel
/// mystical. Tuned down from 6 for fps — every extra sample is a fill
/// call per pulse per frame.
const PULSE_TRAIL_SAMPLES = 4;
const PULSE_TRAIL_SPACING_PROGRESS = 0.055;

/// Arrival sigil — the expanding ring that blooms at a building when a
/// pulse lands. Lifetime is short so concurrent arrivals don't pile up
/// into a blinding flash; max radius scales with the scene so it reads
/// the same at every viewport size.
const ARRIVAL_LIFETIME_MS = 520;
const ARRIVAL_MAX_RADIUS_PX = 44;

export class MissionControlScene extends Phaser.Scene {
  /// Full-window dark fill that sits behind the mission map. Drawn
  /// once in `create()` and resized inline if the user grows the
  /// window (the renderer uses Graphics primitives that don't
  /// auto-respond to scale.resize, so we keep a handle to redraw).
  private backdrop: any = null;
  private map!: any;
  private moat!: any;
  private flow!: any;
  /// Cached castle geometry so update() can re-draw the animated moat
  /// pulse every frame without recomputing layout. Populated by
  /// drawCastle() each renderActivity() pass; null until first draw.
  private moatGeometry: { x: number; y: number; radius: number; active: boolean } | null = null;
  private textObjects: any[] = [];
  /// Focus mode: when true, the Summary + Selected Session + Activity
  /// Feed side panels are skipped and computeLayout() collapses their
  /// widths to 0 so the mission ring (castle + quarters) expands to
  /// fill the full canvas width. The bottom quarter inspector and
  /// replay timeline still render so hover/click + scrubber controls
  /// keep working. Toggled from the topbar button via the global
  /// `__cmcSetPanelsHidden` hook; persisted in localStorage.
  private panelsHidden = false;
  private hoveredQuarterIndex = -1;
  // Sticky last-hover: persists when the pointer leaves the ring so the
  // quarter inspector keeps showing the last thing the user pointed at,
  // instead of snapping back to a previously clicked "pinned" quarter.
  // Click does NOT modify this — hover is the only writer.
  private inspectedQuarterKey: string | null = null;
  private pollEvent?: any;
  private startupRetryEvents: any[] = [];
  private loading = false;
  /// True once the scene has finished its bootstrap ingest. The
  /// initial snapshot of `recent_events` is HISTORICAL — those events
  /// have already been counted by the Rust scanner and are present in
  /// the 24h dedupe set, so animating "live" pulses for them is pure
  /// noise (boxes flow but the badge numbers never move). After
  /// bootstrap completes, real watcher pushes set this so subsequent
  /// ingests animate normally.
  private bootstrapCompleted = false;
  private lastRefresh = 0;
  private userSelectedSession = false;
  private seenEventKeys = new Set<string>();
  private eventLog: CopilotEventSummary[] = [];
  private eventPulses: EventPulse[] = [];
  /// Active arrival sigils. Pushed in `updateEventPulses` when a live
  /// pulse lands; pruned in the same tick once their age exceeds
  /// `ARRIVAL_LIFETIME_MS`. Replay pulses don't spawn sigils — they
  /// fire bursts of historical events at scrub speed and would create
  /// a noisy strobe.
  private arrivalEffects: ArrivalEffect[] = [];
  private demoFlowTimer = 0;
  private demoFlowIndex = 0;
  private replayPaused = false;
  private replayCursor = 0;
  private replayPlayTimer = 0;
  private readonly replayPlaybackInterval = 700;
  private readonly replayMaxEvents = 600;
  /// Rolling 1-min count of tool calls used for the calls/min rate card
  /// and castle sparkline. Each entry is { ts: ms, count: 1 }; we trim
  /// to the trailing 10-minute window during render.
  private toolRateSamples: number[] = [];
  /// Sliding tool-call timestamps split by category for work-mix
  /// sparklines AND the 24h quarter counts. Each entry stores the
  /// event identity key alongside its perfTs so compute24hCategoryCounts
  /// can dedupe live entries against the per-session snapshot —
  /// otherwise live counts that overlap with the snapshot would either
  /// double-count (additive merge) or be silently absorbed (max merge,
  /// the previous bug where pulses fired but the count never moved).
  /// Bucketed to the last 24h, trimmed during render.
  private workMixHistory: Record<string, Array<{ key: string; perfTs: number }>> = {};
  /// Per-session timestamps when they entered needs-attention. Used to
  /// escalate visual + audio alerts at 15s and 30s.
  private attentionEntered: Map<string, number> = new Map();
  /// Sessions we already alerted on for the current attention episode.
  /// Cleared when the session returns to ok/watch.
  private attentionAlertedAt: Map<string, Set<number>> = new Map();
  /// Last seen turn_end timestamp per session — debounces the "turn
  /// ended" chime so a re-render after the same event doesn't replay.
  private turnEndSeen: Map<string, string> = new Map();
  public selectedSessionIndex = 0;

  public activity: CopilotActivity = createEmptyActivity();
  public quarters: Quarter[] = [];
  public layout: MissionLayout | null = null;
  public insightCards: InsightCard[] = [];
  public opsSummary: OpsSummary = createOpsSummary('Disconnected', 'watch', 'Run GitHub Copilot CLI to populate activity.', 'No activity loaded yet.');
  public selectedSession: CopilotSessionSummary | null = null;
  public sessionPickerRows: { id: string; x: number; y: number; w: number; h: number }[] = [];
  public activeEventPulseCount = 0;
  public quarterEventBadges: Record<string, number> = {};
  public hoveredQuarterKey: string | null = null;
  /// `renderActivity()` destroys ~50 Phaser Text objects and recreates
  /// them — each Text uploads a fresh canvas2d → WebGL texture, so
  /// one rebuild can cost 30-100ms. If that spike lands while comet
  /// pulses are flying it drops 3-6 frames and the user sees stutter.
  /// `requestRender()` flips this flag during pulse activity instead
  /// of rebuilding immediately; the per-frame `update()` loop then
  /// flushes a single render once pulses settle.
  private renderPending = false;
  public replayState = {
    paused: false,
    cursor: 0,
    total: 0,
    atLive: true,
  };

  constructor() {
    super('mission-control');
  }

  get displayName() {
    return 'Copilot Mission Control';
  }

  preload() {
    // Single atlas load. assets/space/atlas.png is a transparent-bg
    // 1536x1024 sheet with 79 frames; atlas.json maps frame names →
    // pixel rects. Phaser auto-detects the JSONArray format.
    this.load.atlas(
      SPACE_ATLAS_KEY,
      `${SPACE_ATLAS_ROOT}/atlas.png`,
      `${SPACE_ATLAS_ROOT}/atlas.json`,
    );
  }

  create() {
    // Full-window dark backdrop. Drawn at depth -100 so all mission
    // graphics render above it. Redrawn inline on viewport changes.
    this.backdrop = this.add.graphics().setDepth(-100);
    this.redrawBackdrop();
    // Re-paint the backdrop when Phaser resizes (driven by the
    // window `resize` listener in game.ts → scale.resize(W, H)).
    this.scale.on('resize', () => this.redrawBackdrop());
    // Clean up scene-owned resources on shutdown so a future
    // reload/HMR doesn't leak handlers.
    this.events.once('shutdown', () => this.shutdown());

    this.map = this.add.graphics().setDepth(1);
    // Animated moat ring that pulses when sessions are active. Lives
    // on its own graphics layer so update() can repaint it 60fps
    // without rebuilding the whole scene. Depth 2 keeps it above the
    // map background but below quarter sprites (depth 5+).
    this.moat = this.add.graphics().setDepth(2);
    // ADD blend on the flow layer is set ONCE here (not toggled per
    // frame in updateEventPulses) because nothing else draws to this
    // layer — every pulse trail sample, head, and arrival sigil
    // should blend additively for the mystical glow.
    this.flow = this.add.graphics().setDepth(8).setBlendMode(Phaser.BlendModes.ADD);

    // Restore last-session prefs so context survives a window restart.
    // The migration in loadMissionPrefs() folds older `pinnedDistrictKey`
    // and `inspectedDistrictKey` storage entries into the new key.
    const prefs = loadMissionPrefs();
    this.inspectedQuarterKey = prefs.inspectedQuarterKey ?? null;
    if (prefs.replayPaused) this.replayPaused = true;
    if (typeof prefs.lastSelectedSessionId === 'string') {
      // Mark as user-selected so pickSelectedSession respects the
      // restored id instead of jumping back to the needs-attention
      // session on the first render.
      this.userSelectedSession = true;
      // Actual index resolution happens after activity loads.
    }

    this.activity = this.resolveFixture();
    this.ingestActivityEvents(this.activity.recent_events);
    if (prefs.lastSelectedSessionId) {
      const idx = this.activity.sessions.findIndex(s => s.id === prefs.lastSelectedSessionId);
      if (idx >= 0) this.selectedSessionIndex = idx;
    }
    // Restore persisted focus-mode preference BEFORE the first render so
    // the mission paints in its final layout instead of flashing the
    // side panels in for one frame and then collapsing them.
    try {
      this.panelsHidden = localStorage.getItem('cmc_panels_hidden') === '1';
    } catch { /* private mode / quota — fall back to default false */ }
    this.renderActivity();
    // Bootstrap is done — any further ingest is a genuine push from
    // the watcher, so animate pulses normally. The async refresh below
    // also goes through `ingestActivityEvents` but its events are
    // already in `seenEventKeys` from the bootstrap, so the dedupe
    // makes it a no-op for animation.
    void this.refreshActivity(true).finally(() => {
      this.bootstrapCompleted = true;
    });
    // Push: backend watcher calls this on filesystem changes. Defensive
    // check: only refresh if this scene is still the active one.
    window.__cmcOnAgentActivityChanged = () => {
      if (!this.scene?.isActive?.()) return;
      void this.refreshActivity(true);
    };
    window.__cmcSetTheme = (mode: ThemeMode) => {
      if (!this.scene?.isActive?.()) return;
      setActiveTheme(mode);
      this.redrawBackdrop();
      this.renderActivity();
    };
    // Focus-mode toggle. Hides side panels and re-lays-out the ring so
    // the castle + quarters expand to fill the canvas. Idempotent —
    // hud.js may call this multiple times during its mount poll. The
    // initial value is restored from localStorage above (before the
    // first render) so we early-return when hud.js's first call agrees
    // with what we already painted.
    window.__cmcSetPanelsHidden = (hidden: boolean) => {
      if (!this.scene?.isActive?.()) return;
      const next = !!hidden;
      if (next === this.panelsHidden) return;
      this.panelsHidden = next;
      this.layout = this.computeLayout();
      this.quarters = this.buildQuarters();
      this.renderActivity();
    };
    window.__cmcSelectSession = (id: string) => {
      if (!this.scene?.isActive?.()) return;
      this.selectSessionById(id);
    };
    window.__cmcOpenSelectedSessionInEditor = () => {
      if (!this.scene?.isActive?.()) return;
      this.openSelectedSessionInEditor();
    };
    window.__cmcToggleReplayPause = () => {
      if (!this.scene?.isActive?.()) return;
      this.toggleReplayPause();
    };
    window.__cmcJumpReplayToLive = () => {
      if (!this.scene?.isActive?.()) return;
      this.jumpReplayToLive();
    };
    window.__cmcSeekReplayRatio = (ratio: number) => {
      if (!this.scene?.isActive?.()) return;
      this.seekReplay(Math.round(Math.max(0, Math.min(1, ratio)) * this.eventLog.length));
    };
    // Startup retry ramp: the very first invoke can race the Tauri bridge
    // becoming ready or a Copilot session being mid-write. Re-poll a few
    // times in the first ~10s so the user sees the mission populate
    // quickly rather than waiting for the long-cadence fallback.
    for (const ms of [500, 1500, 3000, 6000, 10000]) {
      const evt = this.time.delayedCall(ms, () => {
        if (this.activity.available && this.activity.sessions.length > 0) return;
        void this.refreshActivity(true);
      });
      this.startupRetryEvents.push(evt);
    }
    // Steady-state poll: covers the case where the watcher fails to attach
    // (e.g., state directory doesn't exist yet, watch limits, etc.). 10s
    // keeps the mission responsive when the user starts a Copilot session
    // after the app has been running for a while.
    this.pollEvent = this.time.addEvent({
      delay: 10000,
      loop: true,
      callback: () => void this.refreshActivity(),
    });
  }

  update(_time: number, delta: number) {
    this.updateHoveredQuarter();
    this.advanceDemoActivity(delta);
    this.advanceReplay(delta);
    this.updateEventPulses(delta);
    this.updateMoatPulse();
    this.updateCursorStyle();
    this.tickAttentionEscalation();
    // Flush a deferred render once pulses settle so the heavy Text
    // teardown/rebuild doesn't interleave with the comet animations.
    this.flushPendingRender();
  }

  /// Coalesces background-driven renders. If pulses are queued or
  /// flying we flip a flag and let the per-frame `flushPendingRender()`
  /// pick it up the moment things settle; if the scene is otherwise
  /// idle we render immediately so the user never sees a stale
  /// dashboard. We check `eventPulses.length` (not the per-frame
  /// `activeEventPulseCount`) because `requestRender` typically fires
  /// straight after `ingestActivityEvents` queues new pulses — those
  /// haven't been counted by `updateEventPulses` yet.
  private requestRender() {
    if (this.eventPulses.length > 0) {
      this.renderPending = true;
      return;
    }
    this.renderPending = false;
    this.renderActivity();
  }

  private flushPendingRender() {
    if (!this.renderPending) return;
    if (this.eventPulses.length > 0) return;
    this.renderPending = false;
    this.renderActivity();
  }

  /// Animated overlay on top of the static moat ring. Only paints when
  /// the cached geometry says sessions are active; otherwise the moat
  /// layer stays empty so the base blue water reads as "calm".
  private updateMoatPulse() {
    if (!this.moat) return;
    this.moat.clear();
    const g = this.moatGeometry;
    if (!g || !g.active) return;
    // Two phase-offset rings, each a slow sine, so the pulse looks
    // like ripples on the water rather than a hard blink. performance.now
    // drives the phase so the animation continues smoothly across
    // renderActivity() rebuilds.
    const t = performance.now() / 1000;
    const baseR = g.radius;
    const ring = (offset: number, baseAlpha: number) => {
      const phase = (Math.sin(t * 1.6 + offset) + 1) / 2;
      const alpha = baseAlpha * (0.4 + phase * 0.6);
      const radius = baseR + phase * 6;
      this.moat.lineStyle(Math.max(2, 3 + phase * 2), 0x60ff9a, alpha);
      this.moat.strokeCircle(g.x, g.y, radius);
    };
    ring(0, 0.55);
    ring(Math.PI, 0.32);
  }

  private updateCursorStyle() {
    const canvas = this.game?.canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;
    const over = this.hoveredQuarterIndex >= 0;
    const desired = over ? 'pointer' : 'default';
    if (canvas.style.cursor !== desired) canvas.style.cursor = desired;
  }

  shutdown() {
    if (this.pollEvent) {
      this.pollEvent.remove(false);
      this.pollEvent = undefined;
    }
    for (const evt of this.startupRetryEvents) {
      evt?.remove?.(false);
    }
    this.startupRetryEvents = [];
    const canvas = this.game?.canvas as HTMLCanvasElement | undefined;
    if (canvas && canvas.style.cursor === 'pointer') canvas.style.cursor = 'default';
    // Only clear the push callback if it still belongs to this scene's
    // handler — guards against a newly-created scene's handler being
    // wiped by a stale shutdown.
    if (window.__cmcOnAgentActivityChanged) {
      window.__cmcOnAgentActivityChanged = undefined;
    }
    if (window.__cmcSetTheme) {
      window.__cmcSetTheme = undefined;
    }
    if (window.__cmcSetPanelsHidden) {
      window.__cmcSetPanelsHidden = undefined;
    }
    window.__cmcSelectSession = undefined;
    window.__cmcOpenSelectedSessionInEditor = undefined;
    window.__cmcToggleReplayPause = undefined;
    window.__cmcJumpReplayToLive = undefined;
    window.__cmcSeekReplayRatio = undefined;
    // Blank the navbar model chip so a stale model id doesn't linger
    // when the scene tears down (game switch, hot reload, etc.).
    try { window.__cmcUpdateModel?.(''); } catch { /* no-op */ }
    this.clearDynamicObjects();
    this.flow?.clear();
    this.moat?.clear();
    this.moatGeometry = null;
    this.eventPulses = [];
    this.arrivalEffects = [];
    this.activeEventPulseCount = 0;
    this.renderPending = false;
    this.eventLog = [];
    this.seenEventKeys.clear();
    this.replayCursor = 0;
    this.replayPaused = false;
    this.replayPlayTimer = 0;
    this.toolRateSamples = [];
    this.workMixHistory = {};
    this.attentionEntered.clear();
    this.attentionAlertedAt.clear();
    this.turnEndSeen.clear();
    if (this.backdrop) {
      try { this.backdrop.destroy(); } catch { /* ignore */ }
      this.backdrop = null;
    }
  }

  /// Repaint the full-window dark fill. Called on `create()` and on
  /// every Phaser scale resize event so the backdrop tracks the
  /// current viewport instead of leaving slivers when the user grows
  /// the window.
  private redrawBackdrop() {
    if (!this.backdrop) return;
    this.backdrop.clear();
    this.backdrop.fillStyle(theme.backdropFill, 1);
    this.backdrop.fillRect(0, 0, W, H);
    this.backdrop.setScrollFactor(0);
  }

  private async refreshActivity(force = false) {
    if (this.loading) return;
    // De-dupe rapid back-to-back calls (e.g. watcher push + poll tick at
    // nearly the same time). Forced calls (initial mount, startup
    // retries, push handler) always go through.
    if (!force && performance.now() - this.lastRefresh < 1200) return;

    this.loading = true;
    try {
      const fixture = this.resolveFixture(false);
      if (fixture.source !== 'browser-empty') {
        this.activity = fixture;
      } else {
        const ti = (window as any).__TAURI_INTERNALS__;
        if (ti?.invoke) {
          try {
            this.activity = await ti.invoke('get_agent_activity') as CopilotActivity;
          } catch {
            this.activity = createEmptyActivity();
          }
        } else {
          this.activity = createEmptyActivity();
        }
      }
      this.lastRefresh = performance.now();
      this.ingestActivityEvents(this.activity.recent_events);
      this.requestRender();
    } finally {
      this.loading = false;
    }
  }

  private resolveFixture(allowAuto = true): CopilotActivity {
    if (window.__missionControlFixture) return normalizeActivity(window.__missionControlFixture);
    if (allowAuto && window.__missionControlAutoFixture) return createDemoActivity();
    return createEmptyActivity();
  }

  private renderActivity() {
    this.clearDynamicObjects();
    this.map.clear();

    this.layout = this.computeLayout();
    this.quarters = this.buildQuarters();
    this.hoveredQuarterKey = this.hoveredQuarterIndex >= 0
      ? this.quarters[this.hoveredQuarterIndex]?.key ?? null
      : null;
    this.opsSummary = buildOpsSummary(this.activity);
    // Surface the ops summary in the HTML top bar (hud.js owns the
    // DOM). Guarded so tests / non-Tauri contexts without the HUD
    // bridge don't crash.
    try {
      (window as any).__cmcUpdateOps?.(this.opsSummary, this.activity.alerts ?? []);
    } catch { /* DOM not ready yet — next render will catch up */ }
    this.selectedSession = this.pickSelectedSession();
    this.insightCards = this.buildInsightCards();
    this.pushSelectedModelToNavbar();

    this.drawBackground();
    this.drawQuarters();
    this.publishDashboardView();
  }

  // Single source of truth for the dashboard layout. Computes panel
  // rects first, then derives the ring radii so quarters never
  // collide with the side panels or the bottom inspector. This must
  // run before buildQuarters so sceneScale and rect math agree.
  private computeLayout(): MissionLayout {
    const s = sceneScale();
    const compact = W < 1600 || H < 900;

    const leftX = Math.max(20, W * 0.018);
    // The ops strip moved into the HTML top bar — the canvas now only
    // needs a small breathing-room margin from the top edge. Keeping
    // opsY/opsH in the layout shape (opsH=0) so downstream readers and
    // the well-bounds math stay unchanged.
    const opsY = Math.max(12, H * 0.018);
    const opsH = 0;
    const topY = opsY + opsH + (compact ? 14 : 22);

    const panelW = this.panelsHidden
      ? 0
      : compact
        ? Math.min(360, Math.max(300, W * 0.32))
        : Math.min(520, Math.max(420, W * 0.3));
    // The left rail now combines selected-session details, actions, and
    // the work-mix chart. Give it enough height to avoid a scrollbar in
    // normal windows; the activity feed below is the scroll-heavy panel.
    const sessionH = Math.min(compact ? 400 : 440, Math.max(390, H * 0.43));

    // Replay strip is DOM-owned and hidden in focus mode so the sector
    // panel can drop to the bottom edge and the mission ring picks up
    // the recovered vertical room.
    const replayH = this.panelsHidden ? 0 : (compact ? 48 : 56);
    const replayMargin = Math.max(12, H * 0.016);
    const replayY = this.panelsHidden ? H : H - replayH - replayMargin;

    // Bottom inspector needs room for wrapped "Also:" detail lines.
    // Keep it noticeably taller than the old strip and let the ring move
    // up into the recovered vertical space above it.
    const bottomH = Math.min(compact ? 172 : 196, Math.max(158, H * 0.18));
    const replayGap = 8;
    // In focus mode the inspector hugs the bottom edge directly
    // (replayMargin only) since the replay strip isn't there to sit
    // above. Otherwise it floats above the replay strip with replayGap
    // breathing room.
    const bottomY = this.panelsHidden
      ? H - bottomH - replayMargin
      : replayY - replayGap - bottomH;

    const inspectorGutter = compact ? 20 : 32;
    const inspectorX = leftX + panelW + inspectorGutter;
    const inspectorW = Math.max(360, W - inspectorX - leftX);

    // Ring well: between side panels horizontally, between ops strip
    // bottom and bottom-inspector top vertically (with gutters).
    const wellGutterX = compact ? 18 : 28;
    // In focus mode the side panels are gone, so the only things bracketing
    // the ring vertically are the topbar above and the inspector below.
    // Tighten the gutters so the ring well grows ~24px vertically; that
    // grows radiusY, spreads N/S buildings further from the castle, and
    // also lifts the ring center up a touch (since wellTop moves up).
    const wellGutterY = this.panelsHidden ? (compact ? 6 : 8) : (compact ? 12 : 20);
    const wellLeft = leftX + panelW + wellGutterX;
    const wellRight = W - leftX - wellGutterX;
    const wellTop = opsY + opsH + wellGutterY;
    const wellBottom = bottomY - wellGutterY;

    const wellW = Math.max(220, wellRight - wellLeft);
    const wellH = Math.max(180, wellBottom - wellTop);

    const centerX = wellLeft + wellW / 2;

    // Quarter sprite half-size. For 8 evenly spaced points on an
    // ellipse, the worst-case chord between adjacent quarters is
    // ~0.77 * min(rx, ry). Quarter sprite must be smaller than that
    // chord to avoid neighbour collisions, so derive sprite size from
    // the smaller radius rather than from pure scene scale. In focus
    // mode we lift the absolute cap so the buildings can grow into
    // the extra horizontal space the hidden side panels left behind;
    // the chord limit still prevents overlap. The +25% bump is the
    // largest that keeps the diagonal brackets clear of the cardinal
    // ones on the bottom-heavy ellipse (labelStackH compensation).
    const rawRadiusX = wellW / 2;
    const rawRadiusY = wellH / 2;
    const minRingRadius = Math.min(rawRadiusX, rawRadiusY);
    const quarterCap = this.panelsHidden ? 80 : 64;
    const quarterR = Math.max(36, Math.min(quarterCap * s, minRingRadius * 0.42));
    const quarterSize = quarterR * 2;

    // Label + count text block below each quarter sprite occupies
    // ~42*pedestalUnit (halo bottom) + 14 + labelSize + countSize px
    // (see drawQuarters). Using the same pedestalUnit (quarterR/64)
    // here as the halo math there means labels follow when focus-mode
    // grows the sprites.
    const labelStackH = Math.round(42 * (quarterR / 64) + 14 + Math.max(14, quarterR * 0.22) + Math.max(18, quarterR * 0.26));

    // The top quarter (Edits) only needs `quarterR` of clearance
    // above its center, while the bottom quarter (Agents) needs
    // `labelStackH` for its label stack. That asymmetry wastes vertical
    // space when we use the smaller of the two for radiusY. Instead,
    // shift the ring's geometric center UP by half the asymmetry so
    // the top and bottom clearance requirements balance — radiusY can
    // then grow to use the freed space. In the normal layout we add a
    // small extra lift so the bottom sector panel has breathing room
    // when its footer wraps.
    const verticalShift = this.panelsHidden
      ? Math.max(0, (labelStackH - quarterR) / 2)
      : Math.max(18, (labelStackH - quarterR) / 2 + 12);
    const centerY = wellTop + wellH / 2 - verticalShift;

    const radiusY = this.panelsHidden
      ? Math.max(100, rawRadiusY - (labelStackH + quarterR) / 2)
      : Math.max(100, rawRadiusY - Math.max(quarterR, labelStackH));

    // The map well is wider than tall now that the right column is gone,
    // so an unconstrained radiusX spreads the diagonal sectors too far
    // from the top/bottom sectors. Cap radiusX so the ring reads as one
    // connected cluster instead of a stretched oval.
    const radiusXCap = radiusY * (this.panelsHidden ? 1.4 : 1.42);
    const radiusX = Math.max(120, Math.min(rawRadiusX - quarterR, radiusXCap));
    const topLift = Math.min(quarterR * 0.6, Math.max(0, wellTop - opsY - opsH - quarterR * 1.4));

    return {
      s, compact,
      leftX, opsY, opsH, topY, panelW,
      sessionH,
      replayH, replayY,
      bottomH, bottomY,
      inspectorX, inspectorW,
      centerX, centerY,
      radiusX, radiusY, quarterR, quarterSize, topLift,
    };
  }

  private buildQuarters(): Quarter[] {
    // Quarter badges show *recent* activity (last 24h) rather than
    // lifetime totals so an idle building actually looks idle. Failed
    // terminal calls are excluded — those aren't actionable for the dev
    // and shouldn't inflate the Commands count.
    const counts = this.compute24hCategoryCounts();

    const layout = this.layout ?? this.computeLayout();
    const { centerX, centerY, radiusX, radiusY, topLift, s } = layout;
    const specs: Omit<Quarter, 'x' | 'y' | 'count' | 'color'>[] = [
      { key: 'forge', label: 'Forge', short: 'Edits' },
      { key: 'library', label: 'Library', short: 'Reads' },
      { key: 'terminal', label: 'Terminal Keep', short: 'Commands' },
      { key: 'signal', label: 'Signal Tower', short: 'Web/Docs' },
      { key: 'delegates', label: 'Guild Hall', short: 'Sub-Agents' },
      { key: 'skills', label: 'Tome Hall', short: 'Skills' },
      { key: 'court', label: 'Royal Court', short: 'Intent' },
      { key: 'mcp', label: 'Envoy House', short: 'MCP' },
    ];

    // Even 45° spacing keeps the ring a true circle around the castle
    // — cos is preserved so the horizontal positions stay symmetric.
    // We then nudge ONLY the four diagonals vertically: upper diagonals
    // (Reads, MCP) shift up, lower diagonals (Web/Docs, Skills) shift
    // down. This opens a visible vertical gap between the diagonals and
    // the side quarters (Commands, Intent) at sin=0 so their labels
    // and brackets don't visually crowd each other. Cardinal positions
    // (top/bottom/sides) stay on the geometric circle.
    const diagonalShift = Math.round(DIAGONAL_QUARTER_SHIFT_PX * Math.max(s, 0.85));

    return specs.map((spec, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / specs.length;
      const lift = index === 0 ? topLift : 0;
      const sinA = Math.sin(angle);
      const isDiagonal = Math.abs(sinA) > 0.1 && Math.abs(sinA) < 0.95;
      const diagY = isDiagonal ? Math.sign(sinA) * diagonalShift : 0;
      return {
        ...spec,
        color: QUARTER_COLORS[spec.key as MissionCategory] ?? 0x9aa6c8,
        x: centerX + Math.cos(angle) * radiusX,
        y: centerY + sinA * radiusY - lift + diagY,
        count: counts.get(spec.key) ?? 0,
      };
    });
  }

  /// Recent activity per quarter (last 24h). Merges two sources to
  /// match what the Activity Feed actually shows:
  ///   1. Per-session `recent_tool_calls` snapshot — catches history
  ///      that existed before the app was running (with category info).
  ///   2. Live `workMixHistory` accumulated from `recent_events` as the
  ///      app saw them — survives even after a session's per-session
  ///      buffer evicts the call. Without this, bursty sessions would
  ///      show 0 for low-volume categories like Intent even though
  ///      events visibly streamed through the Activity Feed.
  /// The merge is additive but deduped via the shared key format so an
  /// event present in BOTH sources only counts once. A previous version
  /// used Math.max(snapshot, live), which silently swallowed live
  /// increments whenever the snapshot dominated — pulses fired but the
  /// count never moved.
  /// Excludes failed terminal commands — those are LLM noise, not
  /// something the dev can fix, so they don't get to inflate "Commands".
  private compute24hCategoryCounts(): Map<string, number> {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const session of this.activity.sessions) {
      for (const call of session.recent_tool_calls ?? []) {
        const ts = Date.parse(call.timestamp);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        if (call.category === 'terminal' && !call.success) continue;
        const key = `${call.timestamp}|${call.tool}|${call.category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(call.category, (counts.get(call.category) ?? 0) + 1);
      }
    }
    const perfCutoff = performance.now() - 24 * 60 * 60_000;
    for (const [category, samples] of Object.entries(this.workMixHistory)) {
      // Terminal stays snapshot-only so the failed-bash filter still
      // applies — workMixHistory tracks start events and has no
      // success info, so merging it would re-inflate Commands with
      // every failed shell call.
      if (category === 'terminal') continue;
      for (const entry of samples) {
        if (entry.perfTs < perfCutoff) continue;
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return counts;
  }

  private buildInsightCards(): InsightCard[] {
    const turns = this.activity.total_turns ?? this.activity.sessions.reduce((sum, s) => sum + (s.turn_count ?? 0), 0);
    const tools = this.activity.total_tool_calls;
    const toolsPerTurn = turns > 0 ? tools / turns : 0;
    const outputTokens = this.activity.total_output_tokens;
    const inputTokens = this.activity.total_input_tokens ?? this.activity.sessions.reduce((sum, s) => sum + (s.input_tokens ?? 0), 0);
    const callsPerMin = this.computeToolCallsPerMin();
    const light = theme.mode === 'light';
    // Accent colors for the four insight cards. Bright dark-theme tones
    // (#60ff9a, #ff7a7a, #ffd54a) become hard to read on a white card in
    // light mode, so swap to darker AA-safe variants.
    const greenAccent = light ? '#1a7a3a' : '#60ff9a';
    const cyanAccent = light ? '#0a5a96' : '#61d6ff';
    const purpleAccent = light ? '#5b3a8c' : '#c9a6ff';
    const goldAccent = light ? theme.text : '#ffd54a';
    const turnsSub = turns > 0
      ? `${toolsPerTurn >= 10 ? toolsPerTurn.toFixed(0) : toolsPerTurn.toFixed(1)} tools/turn`
      : 'no turns yet';
    return [
      { label: 'Active', value: String(this.activity.active_sessions), sub: `${this.activity.scanned_sessions} scanned`, color: this.activity.active_sessions > 0 ? greenAccent : theme.muted },
      { label: 'Tools/min', value: callsPerMin > 0 ? callsPerMin.toFixed(callsPerMin < 10 ? 1 : 0) : '0', sub: `${this.activity.total_tool_calls} total`, color: callsPerMin > 0 ? cyanAccent : theme.muted },
      { label: 'Turns', value: compactNumber(turns), sub: turnsSub, color: turns > 0 ? purpleAccent : theme.muted },
      { label: 'Tokens · 24h', value: compactNumber(inputTokens + outputTokens), sub: `${compactNumberShort(inputTokens)} in · ${compactNumberShort(outputTokens)} out`, subCompact: `${compactNumberShort(inputTokens)}/${compactNumberShort(outputTokens)}`, color: goldAccent },
    ];
  }

  /// Trim the rate sample buffer to the trailing 60s window and return
  /// the count. Used as the "calls/min" insight card and the castle
  /// rate label.
  private computeToolCallsPerMin(): number {
    const cutoff = performance.now() - 60_000;
    while (this.toolRateSamples.length > 0 && this.toolRateSamples[0] < cutoff) {
      this.toolRateSamples.shift();
    }
    return this.toolRateSamples.length;
  }

  private drawBackground() {
    if (theme.mode === 'light') {
      // Subtle light parallax: a near-white wash with very faint bands so
      // the dashboard panels still feel layered without darkening the
      // backdrop.
      this.map.fillStyle(0xf3f6fc, 0.6);
      this.map.fillRect(0, 0, W, H);
      for (let i = 0; i < 22; i++) {
        const alpha = 0.025 + i * 0.003;
        this.map.fillStyle(i % 2 === 0 ? 0xc7d2ec : 0xd6deef, alpha);
        this.map.fillRect(0, (H / 22) * i, W, H / 18);
      }
      return;
    }
    this.map.fillStyle(0x030712, 0.72);
    this.map.fillRect(0, 0, W, H);

    for (let i = 0; i < 22; i++) {
      const alpha = 0.04 + i * 0.005;
      this.map.fillStyle(i % 2 === 0 ? 0x0c1735 : 0x101b3d, alpha);
      this.map.fillRect(0, (H / 22) * i, W, H / 18);
    }
  }

  private drawQuarters() {
    const layout = this.layout!;
    const { centerX, centerY, s, quarterSize, quarterR } = layout;
    const labelBlockH = Math.round(38 * Math.max(s, 0.85));
    const frameH = quarterSize + labelBlockH;
    const topQuarter = this.quarters.find(q => q.key === 'forge');
    const bottomQuarter = this.quarters.find(q => q.key === 'delegates');
    const castleY = topQuarter && bottomQuarter
      ? ((topQuarter.y - quarterSize / 2 + frameH) + (bottomQuarter.y - quarterSize / 2)) / 2
      : centerY;
    this.drawCastle(centerX, castleY, s);

    // Find which quarter the inspector is currently showing so the
    // thick "focused" bracket can track it. Live hover always wins;
    // otherwise the sticky-last-hover key picks the survivor; if neither
    // is set (first paint) nothing gets the focused styling.
    const inspectedIdx = this.hoveredQuarterIndex >= 0
      ? this.hoveredQuarterIndex
      : (this.inspectedQuarterKey
          ? this.quarters.findIndex(d => d.key === this.inspectedQuarterKey)
          : -1);

    for (let i = 0; i < this.quarters.length; i++) {
      const quarter = this.quarters[i];
      const focused = i === inspectedIdx;
      const size = quarterSize;
      const panelTop = quarter.y - size / 2;
      // Extend the corner frame downward so the label + count sit cleanly
      // inside the brackets, below the colored halo (outer radius 54*s,
      // centered at quarter.y - 8s → bottom at quarter.y + 46s).
      const light = theme.mode === 'light';
      // Sector colors intentionally render at full opacity so the sampled
      // reference palette stays visible against the dark mission backdrop.
      const haloAlpha = 1;
      // Every quarter renders with the same colored pedestal regardless
      // of 24h activity count. We used to dim idle quarters to a grey
      // wash, but that read as a visual "bug" against the surrounding
      // active quarters — the activity badge in the corner already
      // signals zero activity, so the desaturation was redundant noise.
      const pedestalColor = quarter.color;
      // Draw the panel/backdrop FIRST so the colored pedestal circle
      // can layer on top of it in dark mode. (Previously the outer
      // circle was drawn first and then the near-opaque dark panel
      // covered it, which is why the colored halos that were so
      // visible in light mode disappeared in dark mode.) Light mode
      // skips the panel fill entirely, so the circle still reads
      // directly against the mission backdrop.
      // Halo radius scales with quarterR (via pedestalUnit) instead of
      // raw scene scale so it keeps its visual proportion when
      // focus-mode bumps the quarter sprite size. labelStackH in
      // computeLayout uses the same unit so labels follow.
      const pedestalUnit = quarterR / 64;
      const haloCenterY = quarter.y - 8 * pedestalUnit;
      this.drawPixelPanel(quarter.x - size / 2, panelTop, size, frameH, quarter.color, focused, s);
      this.map.fillStyle(pedestalColor, haloAlpha);
      this.map.fillCircle(quarter.x, quarter.y - 8 * pedestalUnit, 50 * pedestalUnit);
      const texture = QUARTER_TEXTURES[quarter.key] ?? CENTER_TEXTURE;
      // Constrain the sprite inside a square box (max W = max H = size * 0.72)
      // centered on the halo pedestal. v2 atlas frames are mostly wide/square
      // (aspect 0.9-1.5), so a 0.72 box fills the halo nicely without
      // overflowing the bracket frame — the halo now nearly fills the
      // selector width while leaving the sprite as the focal point.
      const spriteBox = size * 0.72;
      const fit = this.fitSpriteToBox(texture, spriteBox, spriteBox);
      const sprite = this.add.image(quarter.x, haloCenterY, SPACE_ATLAS_KEY, texture)
        .setOrigin(0.5, 0.5)
        .setDepth(7)
        .setAlpha(focused ? 1 : 0.9);
      sprite.setDisplaySize(fit.w, fit.h);
      this.textObjects.push(sprite);
      const labelSize = Math.max(10, Math.round(size * 0.1));
      const countSize = Math.max(13, Math.round(size * 0.13));
      // Place the label just below the visible halo (which now scales
      // with quarterR via pedestalUnit) with a small breathing gap so
      // text never overlaps the disc.
      const labelY = quarter.y + 42 * pedestalUnit + 8 + labelSize / 2;
      const countY = labelY + labelSize / 2 + 6 + countSize / 2;
      const countColor = colorToCss(quarterTextColor(quarter.color));
      this.addText(quarter.x, labelY, quarter.short, labelSize, theme.text).setOrigin(0.5);
      this.addText(quarter.x, countY, String(quarter.count), countSize, countColor).setOrigin(0.5);
    }
  }

  private drawPixelPanel(x: number, y: number, w: number, h: number, color: number, focused: boolean, s: number) {
    const px = snap(x);
    const py = snap(y);
    const pw = snap(w);
    const ph = snap(h);
    const border = Math.max(2, Math.round((focused ? 4 : 2) * s));
    const notch = Math.max(10, Math.round(13 * s));
    // In light mode we drop the panel fill + drop-shadow entirely so the
    // building sprite reads on the mission backdrop and the quarter's
    // colored corner-frame is the only chrome around it. Dark mode keeps
    // the deep card so the sprites pop against the navy backdrop.
    if (theme.mode !== 'light') {
      this.map.fillStyle(0x020713, 0.5);
      this.map.fillRect(px + 7 * s, py + 8 * s, pw, ph);
      this.map.fillStyle(theme.panelBg, 0.94);
      this.map.fillRect(px + notch, py, pw - notch * 2, ph);
      this.map.fillRect(px, py + notch, pw, ph - notch * 2);
    }
    const bracketColor = color;
    const bracketAlpha = 1;
    this.map.fillStyle(bracketColor, bracketAlpha);
    this.map.fillRect(px + notch, py, pw - notch * 2, border);
    this.map.fillRect(px + notch, py + ph - border, pw - notch * 2, border);
    this.map.fillRect(px, py + notch, border, ph - notch * 2);
    this.map.fillRect(px + pw - border, py + notch, border, ph - notch * 2);
    this.map.fillRect(px + border, py + notch - border, notch - border, border);
    this.map.fillRect(px + pw - notch, py + notch - border, notch - border, border);
    this.map.fillRect(px + border, py + ph - notch, notch - border, border);
    this.map.fillRect(px + pw - notch, py + ph - notch, notch - border, border);
  }

  private drawCastle(x: number, y: number, s = sceneScale()) {
    const active = this.activity.active_sessions;
    const layout = this.layout;
    // Castle scales with the available ring size so it doesn't dwarf
    // shrunken quarters on small screens, AND is hard-capped well
    // below native (0.78) so it never visually crowds the surrounding
    // moat / quarters on wider windows. 1.0 looked too dominant at
    // ≥1600 widths; 0.78 keeps the same proportional feel as the
    // older 1280×800 default. We also cap by the free space inside
    // the ring (`moatR + quarterR + gap <= min(radiusX, radiusY)`)
    // so the moat never touches a cardinal quarter on small screens.
    const quarterRingGap = 28;
    const ringHalf = layout ? Math.min(layout.radiusX, layout.radiusY) : 0;
    const moatHeadroom = layout
      ? Math.max(60, ringHalf - layout.quarterR - quarterRingGap) / 132
      : Infinity;
    // Focus mode lifts the absolute cap so the castle can grow into
    // the larger ring without being dwarfed by the now-bigger
    // quarter buildings. moatHeadroom still keeps it from touching
    // the surrounding quarters.
    const castleCap = this.panelsHidden ? 1.1 : 0.78;
    const castleScale = layout
      ? Math.min(s, (layout.quarterSize / 132) * 1.05, moatHeadroom, castleCap)
      : Math.min(s, castleCap);

    // (x, y) is the layout center for the moat and central artwork.
    const moatCx = x;
    const moatCy = y;
    const moatOuterR = 132 * castleScale;
    // Faint surrounding glow so the moat reads as water, not a flat circle.
    this.map.fillStyle(0x1d2a5a, 0.42);
    this.map.fillCircle(moatCx, moatCy, moatOuterR + 4);
    // Water body — solid blue disk filling the entire moat circle.
    this.map.fillStyle(0x0d61f5, 1);
    this.map.fillCircle(moatCx, moatCy, moatOuterR);
    // Outer highlight — a lighter ring at the water's edge for depth.
    this.map.lineStyle(Math.max(1, Math.round(1.5 * castleScale)), 0x6fb4ff, 0.55);
    this.map.strokeCircle(moatCx, moatCy, moatOuterR - 1);

    this.moatGeometry = {
      x: moatCx,
      y: moatCy,
      radius: moatOuterR - Math.max(6, 10 * castleScale) / 2,
      active: active > 0,
    };

    // outpost_domed_island is centered in the moat now that the Active
    // badge no longer occupies the lower center area.
    const castleFit = this.fitSpriteToBox(CENTER_TEXTURE, 220 * castleScale, 190 * castleScale);
    const castle = this.add.image(x, y - 16 * castleScale, SPACE_ATLAS_KEY, CENTER_TEXTURE)
      .setOrigin(0.5, 0.5)
      .setDepth(6);
    castle.setDisplaySize(castleFit.w, castleFit.h);
    this.textObjects.push(castle);
  }

  /// Sticky last-hover model: whatever the user most recently pointed
  /// at stays visible when the pointer moves away. Currently hovered
  /// quarter always wins (immediate response); `inspectedQuarterKey`
  /// is the persisted last-hover. Before the first hover we fall back
  /// to the first quarter so the inspector has something to show.
  private activeInspectedQuarter(): Quarter | undefined {
    const hovered = this.quarters[this.hoveredQuarterIndex];
    if (hovered) return hovered;
    if (this.inspectedQuarterKey) {
      const last = this.quarters.find(d => d.key === this.inspectedQuarterKey);
      if (last) return last;
    }
    return this.quarters[0];
  }

  /// Aggregate live stats for the quarter inspector: top tool, total
  /// calls, average duration (when we have completed entries), and a
  /// short tool list. Replaces the canned advice strings.
  private computeQuarterStats(key: string): { line: string; toolList: string | null } {
    const tools = this.activity.tools.filter(t => t.category === key);
    const topTool = tools[0];
    const calls = tools.reduce((sum, t) => sum + t.count, 0);
    let durSum = 0;
    let durCount = 0;
    for (const session of this.activity.sessions) {
      for (const call of session.recent_tool_calls ?? []) {
        if (call.category === key && typeof call.duration_ms === 'number') {
          durSum += call.duration_ms;
          durCount++;
        }
      }
    }
    const avgMs = durCount > 0 ? Math.round(durSum / durCount) : 0;
    // 24h count matches the quarter badge — same source so badge and
    // inspector tell the same story instead of contradicting each other.
    const last24 = this.compute24hCategoryCounts().get(key) ?? 0;

    const parts: string[] = [];
    if (topTool) parts.push(`top: ${topTool.name} (${topTool.count})`);
    if (calls > 0) parts.push(`${last24}/24h`);
    if (avgMs > 0) parts.push(`avg ${formatDuration(avgMs)}`);
    const line = parts.length > 0 ? parts.join(' · ') : 'No activity routed here yet.';

    const toolList = tools.length > 1
      ? `Also: ${tools.slice(1).map(t => `${t.name} (${t.count})`).join(', ')}`
      : null;
    return { line, toolList };
  }

  private publishDashboardView() {
    if (!window.__cmcRenderDashboard || !this.layout) return;
    const layout = this.layout;
    const compact = layout.compact;
    const sessionOptions = this.getSessionPickerOptions();
    const activeOptions = sessionOptions.filter(({ session }) => session.is_active);
    const pickerOptions = (activeOptions.length > 0 ? activeOptions : sessionOptions.slice(0, 1)).slice(0, 5);
    this.sessionPickerRows = pickerOptions.map(({ session, index }, i) => ({
      id: session.id,
      index,
      title: session.title || session.id,
      status: session.status,
      isActive: session.is_active,
      selected: index === this.selectedSessionIndex,
      shortId: session.id.length > 8 ? session.id.slice(0, 8) : session.id,
      x: layout.leftX + 18,
      y: layout.topY + 80 + i * 30 - 4,
      w: layout.panelW - 36,
      h: 26,
    }));
    const feedY = layout.topY + layout.sessionH + (compact ? 14 : 22);
    const feedH = Math.max(140, layout.bottomY - feedY - 16);
    const visibleLog = this.eventLog.slice(0, this.replayCursor);
    const nowMs = Date.now();
    const feed = visibleLog
      .slice(-30)
      .reverse()
      .map(event => ({ event, ageS: eventAgeSeconds(event.timestamp, nowMs) }))
      .filter(({ ageS }) => ageS <= 300)
      .map(({ event, ageS }) => ({
        label: feedLabel(event),
        age: `${formatAge(ageS)} ago`,
        category: event.category,
        success: event.success,
      }));
    const quarter = this.activeInspectedQuarter();
    const quarterStats = quarter ? this.computeQuarterStats(quarter.key) : null;
    const quarterSessions = quarter
      ? this.activity.sessions.filter(s => this.pickQuarterForSession(s).key === quarter.key)
      : [];
    const flagged = quarter
      ? quarterSessions.filter(quarter.key === 'terminal'
          ? (s: CopilotSessionSummary) => s.status === 'needs-attention'
          : errorOrReview)
      : [];
    const quarterFooter = quarter && flagged.length > 0
      ? `! ${truncate(flagged[0].title || flagged[0].id, 28)} — ${flagged[0].last_tool || 'tool'} failed ${formatAge(flagged[0].stale_seconds)} ago${flagged.length > 1 ? ` (+${flagged.length - 1} more)` : ''}`
      : quarterSessions.length > 0
        ? `${quarterSessions.length} ${quarterSessions.length === 1 ? 'session' : 'sessions'} routed here · ${quarterSessions.filter(s => s.is_active).length} active`
        : '';
    const work = workMix(this.activity);
    const total = this.eventLog.length;
    const cursor = this.replayCursor;
    const atLive = this.isAtLive();
    const replayStatus = total === 0
      ? 'waiting for events'
      : atLive
        ? `${cursor} / ${total} · live`
        : this.replayPaused
          ? `${cursor} / ${total} · paused`
          : `${cursor} / ${total} · replaying`;
    window.__cmcRenderDashboard({
      panelsHidden: this.panelsHidden,
      layout: {
        leftX: layout.leftX,
        topY: layout.topY,
        panelW: layout.panelW,
        compact: layout.compact,
        sessionH: layout.sessionH,
        feedY,
        feedH,
        bottomX: layout.inspectorX,
        bottomY: layout.bottomY,
        bottomW: layout.inspectorW,
        bottomH: layout.bottomH,
        replayX: layout.leftX,
        replayY: layout.replayY,
        replayW: W - layout.leftX * 2,
        replayH: layout.replayH,
      },
      summary: {
        cards: this.insightCards,
        workMix: [
          { label: 'Read', value: work.read, category: 'library' },
          { label: 'Edit', value: work.write, category: 'forge' },
          { label: 'Cmd', value: work.command, category: 'terminal' },
          { label: 'Web', value: work.web, category: 'signal' },
          { label: 'Agent', value: work.task, category: 'delegates' },
          { label: 'MCP', value: work.mcp, category: 'mcp' },
        ],
      },
      sessions: {
        header: activeOptions.length > 0 ? `Running sessions (${activeOptions.length})` : 'Recent sessions (none active)',
        rows: this.sessionPickerRows,
        idleCount: Math.max(0, sessionOptions.length - pickerOptions.length),
        options: sessionOptions.map(({ session, index }) => ({
          id: session.id,
          index,
          title: session.title || session.id,
          shortId: session.id.length > 8 ? session.id.slice(0, 8) : session.id,
          status: session.status,
          isActive: session.is_active,
          mix: {
            read: session.read_count ?? 0,
            write: session.write_count ?? 0,
            command: session.command_count ?? 0,
            web: session.web_count ?? 0,
            task: session.task_count ?? 0,
            mcp: session.mcp_count ?? 0,
          },
        })),
        selected: this.selectedSession,
      },
      feed: {
        title: this.isAtLive() ? 'Activity Feed' : 'Activity Feed · replay view',
        rows: feed,
        empty: this.activity.available
          ? 'No recent Copilot events found. Start a Copilot CLI session and this mission control will wake up.'
          : 'Copilot CLI was not detected. Install or run Copilot CLI to populate this mission.',
      },
      quarter: quarter ? {
        category: quarter.key,
        color: colorToCss(quarter.color),
        title: quarter.short,
        countLine: `${quarter.count} recent ${quarter.short.toLowerCase()} signals`,
        line: quarterStats?.line ?? '',
        toolList: quarterStats?.toolList ?? '',
        footer: quarterFooter,
        footerAlert: flagged.length > 0,
      } : null,
      replay: {
        paused: this.replayPaused,
        atLive,
        cursor,
        total,
        status: replayStatus,
      },
    });
  }

  private addText(x: number, y: number, text: string, size: number, color: string) {
    const obj = this.add.text(x, y, text, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: `${size}px`,
      color,
      stroke: theme.mode === 'light' ? '#c6cfe6' : '#020713',
      strokeThickness: theme.mode === 'light' ? 0 : 3,
    }).setDepth(20);
    this.textObjects.push(obj);
    return obj;
  }

  /// Scale a frame uniformly so it fits inside (maxW, maxH) without
  /// distortion. The space atlas mixes wide consoles (133x119), tall
  /// chairs (85x136), and near-square dishes (127x128) — calling
  /// setDisplaySize(w, h) with fixed numbers would squash them. Reads
  /// the native frame size from the texture cache; falls back to the
  /// box itself if the frame isn't loaded yet (shouldn't happen post-
  /// preload but keeps us safe).
  private fitSpriteToBox(frameName: string, maxW: number, maxH: number) {
    const tex = this.textures.get(SPACE_ATLAS_KEY);
    const frame = tex ? tex.get(frameName) : null;
    const nativeW = frame?.width || maxW;
    const nativeH = frame?.height || maxH;
    const scale = Math.min(maxW / nativeW, maxH / nativeH);
    return { w: nativeW * scale, h: nativeH * scale };
  }

  private updateHoveredQuarter() {
    if (this.quarters.length === 0 || !this.input?.activePointer) return;
    const pointer = this.input.activePointer;
    // Hit area tracks the rendered quarter size (`quarterR`) so the
    // hover region scales with the viewport. A 48px floor prevents the
    // tiny-window layout from becoming pixel-perfect-only.
    const hitR = Math.max(QUARTER_HOVER_RADIUS_MIN_PX, this.layout?.quarterR ?? QUARTER_HOVER_RADIUS_MIN_PX);
    let next = -1;
    for (let i = 0; i < this.quarters.length; i++) {
      const quarter = this.quarters[i];
      const dx = pointer.x - quarter.x;
      const dy = pointer.y - quarter.y;
      if (Math.sqrt(dx * dx + dy * dy) <= hitR) {
        next = i;
        break;
      }
    }
    if (next !== this.hoveredQuarterIndex) {
      this.hoveredQuarterIndex = next;
      // Hovering a new quarter promotes it to the sticky-hover key so
      // the inspector keeps showing it after the pointer leaves the ring.
      // We only WRITE on transition into a quarter (next >= 0) — when
      // the pointer leaves the ring entirely (next === -1) the sticky
      // key intentionally stays put so the panel doesn't blank out.
      if (next >= 0) {
        const d = this.quarters[next];
        if (d && this.inspectedQuarterKey !== d.key) {
          this.inspectedQuarterKey = d.key;
          savePref('inspectedQuarterKey', this.inspectedQuarterKey);
        }
      }
      this.renderActivity();
    }
  }

  private ingestActivityEvents(events: CopilotEventSummary[]) {
    if (events.length === 0) return;
    const wasAtLive = this.isAtLive();
    const chronological = [...events].reverse();
    const appended: CopilotEventSummary[] = [];
    const nowMs = performance.now();
    for (const event of chronological) {
      const key = eventKey(event);
      if (this.seenEventKeys.has(key)) continue;
      this.seenEventKeys.add(key);
      this.eventLog.push(event);
      appended.push(event);
      // Track rolling rates/histories. Both buffers self-trim during
      // render so unbounded growth is impossible. The live entry's key
      // matches the per-session snapshot's dedupe format so
      // compute24hCategoryCounts can merge the two sources without
      // double-counting overlap.
      if (event.kind === 'tool.execution_start') {
        this.toolRateSamples.push(nowMs);
        const bucket = (this.workMixHistory[event.category] ??= []);
        bucket.push({ key: `${event.timestamp}|${event.tool}|${event.category}`, perfTs: nowMs });
      }
      // Turn-end chime: one per session, debounced by timestamp so a
      // re-render of the same event doesn't replay the sound.
      if (event.kind === 'assistant.turn_end') {
        const lastSeen = this.turnEndSeen.get(event.session_id);
        if (lastSeen !== event.timestamp) {
          this.turnEndSeen.set(event.session_id, event.timestamp);
          if (this.bootstrapCompleted) {
            this.playChime('turn-end');
            this.maybeNotify(`Copilot finished — ${event.session_id}`, 'Open Mission Control to review the results.');
          }
        }
      }
    }
    if (appended.length === 0) return;

    if (this.eventLog.length > this.replayMaxEvents) {
      const trim = this.eventLog.length - this.replayMaxEvents;
      const removed = this.eventLog.splice(0, trim);
      for (const event of removed) this.seenEventKeys.delete(eventKey(event));
      this.replayCursor = Math.max(0, this.replayCursor - trim);
    }

    if (wasAtLive && !this.replayPaused && this.bootstrapCompleted) {
      if (this.quarters.length > 0) {
        for (let i = 0; i < appended.length; i++) {
          this.queueEventPulse(appended[i], 'live', i * PULSE_STAGGER_MS);
        }
      }
      this.replayCursor = this.eventLog.length;
    } else if (wasAtLive && !this.replayPaused) {
      // Bootstrap path: still advance the cursor so the user is "at
      // live" from the start, but skip the pulse animation.
      this.replayCursor = this.eventLog.length;
    }
    this.updateReplayState();
  }

  /// Per-frame attention escalation. Fires bell + OS notification when
  /// a session first enters needs-attention, then re-fires at 15s and
  /// 30s if the user hasn't responded. Also clears stale entries when
  /// the session returns to a non-review state.
  private tickAttentionEscalation() {
    const nowMs = performance.now();
    const reviewIds = new Set<string>();
    for (const session of this.activity.sessions) {
      if (!errorOrReview(session)) continue;
      reviewIds.add(session.id);
      if (!this.attentionEntered.has(session.id)) {
        this.attentionEntered.set(session.id, nowMs);
        this.attentionAlertedAt.set(session.id, new Set([0]));
        this.playChime('attention');
        this.maybeNotify(`Copilot needs attention — ${session.id}`, this.attentionNotificationBody(session), 'attention');
        continue;
      }
      const entered = this.attentionEntered.get(session.id)!;
      const elapsed = (nowMs - entered) / 1000;
      const alerted = this.attentionAlertedAt.get(session.id)!;
      for (const escalation of [15, 30]) {
        if (elapsed >= escalation && !alerted.has(escalation)) {
          alerted.add(escalation);
          this.playChime('attention');
          this.maybeNotify(`Still waiting — ${session.id} (${escalation}s)`, this.attentionNotificationBody(session), 'attention');
        }
      }
    }
    // Clear sessions that recovered or disappeared.
    for (const id of [...this.attentionEntered.keys()]) {
      if (!reviewIds.has(id)) {
        this.attentionEntered.delete(id);
        this.attentionAlertedAt.delete(id);
      }
    }
  }

  private attentionNotificationBody(session: CopilotSessionSummary) {
    const tool = session.last_tool ? `Last tool: ${session.last_tool}` : 'Tool failed or stalled';
    return `${session.repository} · ${tool}`;
  }

  /// Best-effort web Notification. Falls through silently if perms are
  /// denied or the API is unavailable — we never want to block UI on a
  /// notification round-trip.
  private maybeNotify(title: string, body: string, tag?: string) {
    if (this.activity.source === 'playwright-fixture') return;
    if (typeof Notification === 'undefined') return;
    const fire = () => {
      try {
        new Notification(title, { body, tag: tag ?? 'mission-control', silent: true });
      } catch { /* ignore */ }
    };
    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => { if (p === 'granted') fire(); }).catch(() => { /* ignore */ });
    }
  }

  private playChime(_variant: 'turn-end' | 'attention') {
    // Intentionally silent: Mission Control is a passive monitor and must
    // never emit app-generated audio.
  }

  private isAtLive() {
    return this.replayCursor >= this.eventLog.length;
  }

  private updateReplayState() {
    this.replayState = {
      paused: this.replayPaused,
      cursor: this.replayCursor,
      total: this.eventLog.length,
      atLive: this.isAtLive(),
    };
  }

  private queueEventPulse(event: CopilotEventSummary, source: 'live' | 'replay' = 'live', delay = 0) {
    // Pulses must be in lock-step with workMixHistory so the count and
    // the visible flow agree. workMixHistory only increments for
    // tool.execution_start, so we only pulse for tool.execution_start.
    // Completion events (success "complete" and failure "alert") still
    // show up in the Activity Feed but no longer fabricate a building
    // animation that the count can't justify.
    if (event.kind !== 'tool.execution_start') return;
    const quarterKey = quarterKeyForEvent(event);
    if (!quarterKey) return;
    const quarter = this.quarters.find(d => d.key === quarterKey);
    if (!quarter) return;

    const s = sceneScale();
    // Real castle center, cached when drawCastle() ran. Falls back to
    // the previous heuristic only on pre-bootstrap rendering when the
    // geometry isn't populated yet (rare; one frame at most).
    const castleX = this.moatGeometry?.x ?? W * 0.5;
    const castleY = this.moatGeometry?.y ?? H * 0.52;
    // Pulse color matches the bracket line color so the dot that flies
    // toward a building reads as the same visual element. In light mode
    // brackets are darkened for contrast, so the pulse follows.
    const pulseColor = event.success ? quarterTextColor(quarter.color) : 0xff5252;
    this.eventPulses.push({
      id: `${source}:${eventKey(event)}:${performance.now()}`,
      quarterKey,
      color: pulseColor,
      // Spawn from the castle center so every pulse — including those
      // bound for diagonal quarters (Guild Hall, Tome Hall, Signal
      // Tower, MCP) — visibly leaves the castle. Previously startY was
      // offset by ±100px which made pulses to diagonals appear to
      // spawn well above or below the castle, breaking the metaphor.
      startX: castleX,
      startY: castleY,
      midX: quarter.x,
      endX: quarter.x,
      // Stop just short of the quarter sprite center so the arrival
      // sigil at quarter.x/y reads as the building "receiving" the
      // pulse rather than the pulse driving through it.
      endY: quarter.y + (quarter.y < castleY ? -36 * s : 36 * s),
      progress: 0,
      duration: 900,
      delay,
      arrived: false,
      source,
    });
    this.activeEventPulseCount = this.eventPulses.length;
  }

  private updateEventPulses(delta: number) {
    if (!this.flow) return;
    this.flow.clear();
    if (this.eventPulses.length === 0 && this.arrivalEffects.length === 0) {
      this.activeEventPulseCount = 0;
      return;
    }

    const s = sceneScale();
    const headSize = 8 * s;
    const halfHead = headSize / 2;
    // Pre-derived trail sizes so we don't recompute per pulse.
    // Each sample i in [1..PULSE_TRAIL_SAMPLES] shrinks the size and
    // alpha linearly toward the back so the tail tapers off as a wisp.
    // Pre-computed once per frame — was per-sample-per-pulse before.
    const trailSizes = new Array(PULSE_TRAIL_SAMPLES);
    const trailHalves = new Array(PULSE_TRAIL_SAMPLES);
    const trailAlphas = new Array(PULSE_TRAIL_SAMPLES);
    for (let i = 1; i <= PULSE_TRAIL_SAMPLES; i++) {
      const t = i / PULSE_TRAIL_SAMPLES;
      const sz = headSize * (1 - t * 0.65);
      trailSizes[i - 1] = sz;
      trailHalves[i - 1] = sz / 2;
      trailAlphas[i - 1] = 0.32 * (1 - t);
    }

    for (const pulse of this.eventPulses) {
      pulse.delay -= delta;
      if (pulse.delay > 0) continue;
      pulse.progress = Math.min(1, pulse.progress + delta / pulse.duration);

      // Glowing comet tail — sample the bezier path BEHIND the head.
      // Math is inlined (no pulsePoint(...spread) call) — that previous
      // spread allocated a fresh object 4× per pulse per frame which
      // showed up as GC stutter once a few pulses were in flight.
      // We also use fillRect (matches the head silhouette and is
      // cheaper than fillCircle on the WebGL Graphics pipeline).
      for (let i = 0; i < PULSE_TRAIL_SAMPLES; i++) {
        const sampleProgress = pulse.progress - (i + 1) * PULSE_TRAIL_SPACING_PROGRESS;
        if (sampleProgress <= 0) continue;
        let tx: number;
        let ty: number;
        if (sampleProgress < 0.55) {
          const local = sampleProgress / 0.55;
          tx = pulse.startX + (pulse.midX - pulse.startX) * local;
          ty = pulse.startY;
        } else {
          const local = (sampleProgress - 0.55) / 0.45;
          tx = pulse.endX;
          ty = pulse.startY + (pulse.endY - pulse.startY) * local;
        }
        const sz = trailSizes[i];
        const half = trailHalves[i];
        this.flow.fillStyle(pulse.color, trailAlphas[i]);
        this.flow.fillRect(snap(tx - half), snap(ty - half), snap(sz), snap(sz));
      }

      // Pulse head — soft square halo + crisp inner box. Both are
      // rects, both blend additively via the flow layer's once-set
      // ADD blend mode. The halo is ~2× the head size to bloom under
      // the additive blend without smearing.
      const point = pulsePoint(pulse);
      const haloHalf = headSize;
      this.flow.fillStyle(pulse.color, 0.22);
      this.flow.fillRect(snap(point.x - haloHalf), snap(point.y - haloHalf), snap(haloHalf * 2), snap(haloHalf * 2));
      this.flow.fillStyle(pulse.color, 0.95);
      this.flow.fillRect(snap(point.x - halfHead), snap(point.y - halfHead), snap(headSize), snap(headSize));

      if (pulse.progress >= 1 && !pulse.arrived) {
        pulse.arrived = true;
        if (pulse.source === 'live') {
          this.incrementQuarterActivity(pulse.quarterKey);
          // Sigil at the building's actual center (not the pulse's
          // arrival point, which is offset above/below the building).
          const quarter = this.quarters.find(d => d.key === pulse.quarterKey);
          if (quarter) {
            this.arrivalEffects.push({
              x: quarter.x,
              y: quarter.y,
              color: pulse.color,
              age: 0,
              lifetime: ARRIVAL_LIFETIME_MS,
            });
          }
        }
      }
    }

    // Arrival sigils — expanding ring + soft inner fill that fades as
    // it grows. Eased so the bloom is fast early then settles.
    // Strokes are cheaper than nested fills; one stroke + one fill per
    // sigil per frame keeps the cost bounded.
    for (const eff of this.arrivalEffects) {
      eff.age += delta;
      const t = eff.age >= eff.lifetime ? 1 : eff.age / eff.lifetime;
      // ease-out cubic so the ring snaps open then slows.
      const eased = 1 - Math.pow(1 - t, 3);
      const radius = ARRIVAL_MAX_RADIUS_PX * s * eased;
      const ringAlpha = 0.75 * (1 - t);
      const fillAlpha = 0.18 * (1 - t * t);
      const ringWidth = Math.max(2, 4 * s * (1 - t));
      const ex = snap(eff.x);
      const ey = snap(eff.y);
      this.flow.fillStyle(eff.color, fillAlpha);
      this.flow.fillCircle(ex, ey, radius);
      this.flow.lineStyle(ringWidth, eff.color, ringAlpha);
      this.flow.strokeCircle(ex, ey, radius);
    }

    this.eventPulses = this.eventPulses.filter(pulse => pulse.progress < 1);
    this.arrivalEffects = this.arrivalEffects.filter(eff => eff.age < eff.lifetime);
    this.activeEventPulseCount = this.eventPulses.length;
  }

  /// Reserved for future per-pulse-arrival hook. Currently a no-op:
  /// quarter badge counts are sourced from `compute24hCategoryCounts`
  /// which reads `workMixHistory` — updated in `ingestActivityEvents`
  /// BEFORE the pulse is even queued. The previous implementation
  /// triggered a full `renderActivity()` rebuild on every arrival just
  /// to redraw the same number, which destroyed framerate during
  /// bursts (8+ full scene rebuilds/second). The arrival sigil is now
  /// the sole visual feedback for "pulse landed".
  private incrementQuarterActivity(_key: MissionCategory) {
    // intentionally empty — see comment above.
  }

  private advanceDemoActivity(delta: number) {
    if (this.activity.source !== 'demo-fixture') return;
    if (this.replayPaused) return;
    this.demoFlowTimer += delta;
    if (this.demoFlowTimer < 900 || this.quarters.length === 0) return;
    this.demoFlowTimer = 0;

    const event = createDemoEvent(this.demoFlowIndex++);
    this.activity = applyDemoEvent(this.activity, event);
    this.ingestActivityEvents([event]);
    this.renderActivity();
  }

  private advanceReplay(delta: number) {
    if (this.replayPaused) return;
    if (this.isAtLive() || this.quarters.length === 0) return;
    this.replayPlayTimer += delta;
    while (this.replayPlayTimer >= this.replayPlaybackInterval && !this.isAtLive()) {
      this.replayPlayTimer -= this.replayPlaybackInterval;
      const event = this.eventLog[this.replayCursor++];
      this.queueEventPulse(event, 'replay');
    }
    if (this.isAtLive()) {
      this.replayPlayTimer = 0;
    }
    this.updateReplayState();
  }

  public seekReplay(cursor: number) {
    const clamped = Math.max(0, Math.min(this.eventLog.length, Math.round(cursor)));
    if (clamped === this.replayCursor) return;
    this.replayCursor = clamped;
    this.replayPlayTimer = 0;
    this.eventPulses = this.eventPulses.filter(p => p.source === 'live' && !p.arrived);
    this.activeEventPulseCount = this.eventPulses.length;
    this.updateReplayState();
    this.renderActivity();
  }

  public toggleReplayPause() {
    this.replayPaused = !this.replayPaused;
    this.replayPlayTimer = 0;
    savePref('replayPaused', this.replayPaused);
    this.updateReplayState();
    this.renderActivity();
  }

  public jumpReplayToLive() {
    this.replayPaused = false;
    this.replayCursor = this.eventLog.length;
    this.replayPlayTimer = 0;
    this.eventPulses = this.eventPulses.filter(p => p.source === 'live' && !p.arrived);
    this.activeEventPulseCount = this.eventPulses.length;
    this.updateReplayState();
    this.renderActivity();
  }

  private pickSelectedSession() {
    const sessions = this.activity.sessions;
    if (sessions.length === 0) return null;
    // Honor a sticky id from prefs first — session order can change
    // between scans, so tracking by id keeps the user pinned to the
    // session they were actually inspecting.
    if (this.userSelectedSession) {
      const prefs = loadMissionPrefs();
      if (prefs.lastSelectedSessionId) {
        const idx = sessions.findIndex(s => s.id === prefs.lastSelectedSessionId);
        if (idx >= 0) {
          this.selectedSessionIndex = idx;
          return sessions[idx];
        }
      }
    }
    const safeIndex = Math.max(0, Math.min(this.selectedSessionIndex, sessions.length - 1));
    this.selectedSessionIndex = safeIndex;
    if (!this.userSelectedSession) {
      const reviewSession = sessions.find(session => session.is_active && errorOrReview(session));
      if (reviewSession) {
        this.selectedSessionIndex = sessions.indexOf(reviewSession);
        return reviewSession;
      }
    }
    return sessions[safeIndex] ?? sessions.find(session => session.is_active) ?? sessions[0];
  }

  /// Push the currently-selected session's model id to the navbar
  /// chip via the global `__cmcUpdateModel` hook. Fires on every
  /// `renderActivity()` call so it covers (1) initial bootstrap,
  /// (2) the user clicking a different session, and (3) a mid-session
  /// model switch where the same session's `last_model` changes
  /// between scans. The hud.js helper short-circuits if the value
  /// hasn't actually changed, so calling it on every render is cheap.
  private pushSelectedModelToNavbar() {
    try {
      const model = this.selectedSession?.last_model ?? '';
      window.__cmcUpdateModel?.(model);
    } catch {
      /* DOM not ready yet — next render will catch up */
    }
  }

  private getSessionPickerOptions() {
    const indexed = this.activity.sessions.map((session, index) => ({ session, index }));
    const active = indexed.filter(({ session }) => session.is_active);
    const options = active.length > 0 ? active : indexed;
    return options.sort((a, b) => {
      const aReview = errorOrReview(a.session) ? 1 : 0;
      const bReview = errorOrReview(b.session) ? 1 : 0;
      return bReview - aReview || Number(b.session.is_active) - Number(a.session.is_active);
    });
  }

  private selectSession(index: number) {
    if (!this.activity.sessions[index]) return;
    this.selectedSessionIndex = index;
    this.userSelectedSession = true;
    savePref('lastSelectedSessionId', this.activity.sessions[index].id);
    this.renderActivity();
  }

  private selectSessionById(id: string) {
    const index = this.activity.sessions.findIndex(s => s.id === id);
    if (index >= 0) this.selectSession(index);
  }

  private openSelectedSessionInEditor() {
    const session = this.selectedSession;
    if (!session?.git_root) return;
    const ti = (window as any).__TAURI_INTERNALS__;
    // Use our own command (not the opener plugin's open_url) because
    // the plugin's default scope rejects custom schemes like vscode://.
    // Falls back to window.open for the playwright fixture which has no
    // Tauri bridge.
    if (ti?.invoke) {
      ti.invoke('open_in_editor', { path: session.git_root, scheme: 'vscode' }).catch((err: any) => {
        console.warn('open_in_editor failed', err);
      });
    } else {
      try { window.open(`vscode://file/${session.git_root}`, '_blank'); } catch { /* ignore */ }
    }
  }

  private pickQuarterForSession(session: CopilotSessionSummary) {
    const preferred = session.last_event_category && this.quarters.some(d => d.key === session.last_event_category)
      ? session.last_event_category
      : session.error_count > 0
      ? 'terminal'
      : session.write_count >= session.read_count && session.write_count > 0
        ? 'forge'
        : session.command_count > 0
          ? 'terminal'
          : session.web_count > 0
            ? 'signal'
            : session.task_count > 0
              ? 'delegates'
              : 'library';
    return this.quarters.find(d => d.key === preferred) ?? this.quarters[0];
  }

  private clearDynamicObjects() {
    for (const text of this.textObjects) text.destroy();
    this.textObjects = [];
    this.sessionPickerRows = [];
  }
}

function createEmptyActivity(): CopilotActivity {
  return {
    available: false,
    source: 'browser-empty',
    scanned_sessions: 0,
    active_sessions: 0,
    total_events: 0,
    total_tool_calls: 0,
    total_output_tokens: 0,
    sessions: [],
    tools: [],
    recent_events: [],
    alerts: ['Waiting for GitHub Copilot CLI telemetry.'],
    generated_at_ms: Date.now(),
  };
}

function createOpsSummary(mode: string, attention: AttentionLevel, recommendation: string, reason: string): OpsSummary {
  return { mode, attention, recommendation, reason };
}

function buildOpsSummary(activity: CopilotActivity): OpsSummary {
  if (!activity.available) {
    return createOpsSummary(
      'Disconnected',
      'watch',
      'Install or run GitHub Copilot CLI to populate live activity.',
      'Copilot CLI executable or session state is unavailable.',
    );
  }

  // Concrete operational signals first — these matter far more than the
  // generic mode label because they tell the user whether their agent
  // is healthy or stuck. Each rule below maps to an actionable signal.
  const concrete = detectConcreteOpsSignal(activity);
  if (concrete) return concrete;

  const activeSessions = activity.sessions.filter(session => session.is_active);

  if (activeSessions.length === 0) {
    return createOpsSummary(
      'Idle',
      'ok',
      'Safe to context-switch · nothing active in the last 10 min.',
      'No sessions changed in the active window.',
    );
  }

  const mix = workMix({ ...activity, sessions: activeSessions });
  const dominant = dominantWork(mix);
  const recent = activity.recent_events[0];
  const sessionList = activeSessions.map(s => s.id).join(', ');
  if (recent?.category === 'waiting' || recent?.category === 'prompt' || recent?.category === 'arrival') {
    return createOpsSummary(
      'Waiting',
      'watch',
      `Copilot is waiting on you · ${sessionList}`,
      `Latest signal is ${recent.category}.`,
    );
  }

  if (dominant === 'command') {
    return createOpsSummary('Validating', 'ok', `Running commands/tests · ${sessionList}`, 'Command/test tools dominate active work.');
  }
  if (dominant === 'write') {
    return createOpsSummary('Editing', 'watch', `Changing files · review diffs · ${sessionList}`, 'Edit tools dominate active work.');
  }
  if (dominant === 'read') {
    return createOpsSummary('Gathering context', 'ok', `Reading source · ${sessionList}`, 'Read/search tools dominate active work.');
  }
  if (dominant === 'web') {
    return createOpsSummary('Researching', 'ok', `Fetching docs/web · ${sessionList}`, 'Web/docs tools dominate active work.');
  }
  if (dominant === 'task') {
    return createOpsSummary('Delegating', 'watch', `Sub-agent active · ${sessionList}`, 'Delegation tools dominate active work.');
  }

  return createOpsSummary('Working', 'ok', `Active · ${sessionList}`, 'Active session has recent signals.');
}

/// Inspect the trailing event stream for telltale signs of trouble:
/// possible hangs (long-running command with no completion), possible
/// loops (same tool fired many times in a short window), and recent
/// failures. Returns null when nothing stands out — the caller then
/// falls back to mode-based messaging.
function detectConcreteOpsSignal(activity: CopilotActivity): OpsSummary | null {
  const events = activity.recent_events;
  const sessions = activity.sessions.filter(s => s.is_active);
  const activeIds = new Set(sessions.map(s => s.id));

  // 1. Failure tied to an active session. Stale failures from idle
  // sessions are intentionally ignored so old noise doesn't keep the
  // dashboard pinned to "Needs review" forever.
  const erroredActive = sessions.find(s => s.error_count > 0);
  const lastFailure = events.find(e =>
    e.kind === 'tool.execution_complete' && !e.success && activeIds.has(e.session_id)
  );
  if (erroredActive || lastFailure) {
    // Identify the failing session by name so the user can locate it in
    // the Sessions panel without first having to select it. The chip
    // alone (NEEDS REVIEW) is what conveys severity; the recommendation
    // text just describes what happened and where.
    const target = erroredActive
      ?? sessions.find(s => s.id === lastFailure?.session_id)
      ?? sessions[0];
    const tool = target?.last_tool ?? lastFailure?.tool ?? 'tool';
    const sessionLabel = target ? (target.title || target.id) : 'active session';
    const ago = typeof target?.stale_seconds === 'number' ? ` ${formatAge(target.stale_seconds)} ago` : '';
    return createOpsSummary(
      'Needs review',
      'review',
      `${tool} failed${ago} in ${sessionLabel}`,
      'Active session has one or more tool failures.',
    );
  }

  // (Removed: "Long-running" heuristic — too noisy. A tool with no
  // completion event is often just legitimately slow; surfacing it as
  // "check if it's hung" recommended action proved unhelpful in
  // practice.)

  // 3. Possible loop: same tool fired 5+ times in the trailing 10
  // active-session events.
  const trailing = events.slice(0, 10).filter(e => activeIds.has(e.session_id));
  const counts = new Map<string, number>();
  for (const e of trailing) {
    if (e.kind === 'tool.execution_start') {
      counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
    }
  }
  const looped = [...counts.entries()].find(([, c]) => c >= 5);
  if (looped) {
    return createOpsSummary(
      'Possible loop',
      'watch',
      `${looped[0]} called ${looped[1]}× recently · consider interrupting`,
      'A single tool name dominates the recent event window.',
    );
  }

  return null;
}

function workMix(activity: CopilotActivity) {
  return activity.sessions.reduce(
    (mix, session) => ({
      read: mix.read + session.read_count,
      write: mix.write + session.write_count,
      command: mix.command + session.command_count,
      web: mix.web + session.web_count,
      task: mix.task + session.task_count,
      mcp: mix.mcp + (session.mcp_count ?? 0),
    }),
    { read: 0, write: 0, command: 0, web: 0, task: 0, mcp: 0 },
  );
}

function dominantWork(mix: ReturnType<typeof workMix>) {
  const entries = Object.entries(mix) as [keyof typeof mix, number][];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[1] > 0 ? entries[0][0] : 'activity';
}

function createDemoActivity(): CopilotActivity {
  const recentEvents = createDemoEvents(36);
  return {
    available: true,
    source: 'demo-fixture',
    scanned_sessions: 4,
    active_sessions: 3,
    total_events: 360,
    total_tool_calls: 140,
    total_output_tokens: 24380,
    sessions: [
      { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'working', event_count: 128, tool_count: 55, write_count: 16, read_count: 22, command_count: 10, web_count: 3, task_count: 4, error_count: 0, output_tokens: 9800, last_tool: 'apply_patch', last_event_category: 'forge' },
      { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'needs-attention', event_count: 96, tool_count: 42, write_count: 5, read_count: 14, command_count: 18, web_count: 0, task_count: 5, error_count: 2, output_tokens: 6120, last_tool: 'bash', last_event_category: 'alert' },
      { id: 'gamma890', title: 'Research UI', repository: 'docs', branch: 'main', updated_at: '', is_active: true, status: 'thinking', event_count: 74, tool_count: 28, write_count: 1, read_count: 11, command_count: 1, web_count: 13, task_count: 2, error_count: 0, output_tokens: 5450, last_tool: 'web_fetch', last_event_category: 'signal' },
      { id: 'delta321', title: 'Plan Refactor', repository: 'copilot-mission-control', branch: 'feature/mission', updated_at: '', is_active: false, status: 'idle', event_count: 62, tool_count: 15, write_count: 2, read_count: 8, command_count: 1, web_count: 1, task_count: 3, error_count: 0, output_tokens: 3010, last_tool: 'task', last_event_category: 'delegates' },
    ],
    tools: [
      { name: 'view', category: 'library', count: 33 },
      { name: 'apply_patch', category: 'forge', count: 14 },
      { name: 'bash', category: 'terminal', count: 44 },
      { name: 'rg', category: 'library', count: 16 },
      { name: 'task', category: 'delegates', count: 8 },
      { name: 'web_fetch', category: 'signal', count: 7 },
      { name: 'prompt', category: 'court', count: 18 },
    ],
    recent_events: recentEvents,
    alerts: ['2 recent command failures need review.'],
    generated_at_ms: Date.now(),
  };
}

function createDemoEvents(count: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, offset) => createDemoEvent(count - offset, now - offset * 12_000));
}

function createDemoEvent(index: number, timestampMs = Date.now()): CopilotEventSummary {
  const flow = [
    { session_id: 'alpha123', kind: 'tool.execution_start', tool: 'view', category: 'library', success: true },
    { session_id: 'alpha123', kind: 'tool.execution_start', tool: 'apply_patch', category: 'forge', success: true },
    { session_id: 'beta4567', kind: 'tool.execution_start', tool: 'bash', category: 'terminal', success: true },
    { session_id: 'gamma890', kind: 'tool.execution_start', tool: 'web_fetch', category: 'signal', success: true },
    { session_id: 'delta321', kind: 'tool.execution_start', tool: 'task', category: 'delegates', success: true },
    { session_id: 'alpha123', kind: 'user.message', tool: 'prompt', category: 'court', success: true },
    { session_id: 'beta4567', kind: 'tool.execution_complete', tool: 'bash', category: 'alert', success: false },
    { session_id: 'gamma890', kind: 'assistant.turn_start', tool: 'thinking', category: 'thinking', success: true },
    { session_id: 'alpha123', kind: 'tool.execution_start', tool: 'rg', category: 'library', success: true },
    { session_id: 'beta4567', kind: 'tool.execution_complete', tool: 'tool complete', category: 'terminal', success: true },
  ] as const;
  const template = flow[index % flow.length];
  return {
    ...template,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

function applyDemoEvent(activity: CopilotActivity, event: CopilotEventSummary): CopilotActivity {
  const quarterKey = quarterKeyForEvent(event);
  const toolCategory = quarterKey ?? event.category;
  const toolName = event.tool || event.kind;
  const tools = [...activity.tools];
  const tool = tools.find(metric => metric.name === toolName && metric.category === toolCategory);
  if (tool) {
    tool.count += 1;
  } else {
    tools.push({ name: toolName, category: toolCategory, count: 1 });
  }

  const sessions = activity.sessions.map(session => {
    if (session.id !== event.session_id) return session;
    return {
      ...session,
      is_active: true,
      status: event.success ? (event.category === 'thinking' ? 'thinking' : 'working') : 'needs-attention',
      event_count: session.event_count + 1,
      tool_count: event.kind.startsWith('tool.') ? session.tool_count + 1 : session.tool_count,
      write_count: quarterKey === 'forge' ? session.write_count + 1 : session.write_count,
      read_count: quarterKey === 'library' ? session.read_count + 1 : session.read_count,
      command_count: quarterKey === 'terminal' ? session.command_count + 1 : session.command_count,
      web_count: quarterKey === 'signal' ? session.web_count + 1 : session.web_count,
      task_count: quarterKey === 'delegates' ? session.task_count + 1 : session.task_count,
      mcp_count: quarterKey === 'mcp' ? (session.mcp_count ?? 0) + 1 : (session.mcp_count ?? 0),
      error_count: event.success ? session.error_count : session.error_count + 1,
      output_tokens: session.output_tokens + 120,
      last_tool: event.tool,
      last_event_kind: event.kind,
      last_event_category: event.category,
      last_event_timestamp: event.timestamp,
      stale_seconds: 0,
    };
  });

  return {
    ...activity,
    active_sessions: sessions.filter(session => session.is_active).length,
    total_events: activity.total_events + 1,
    total_tool_calls: event.kind.startsWith('tool.') ? activity.total_tool_calls + 1 : activity.total_tool_calls,
    total_output_tokens: activity.total_output_tokens + 120,
    sessions,
    tools,
    recent_events: [event, ...activity.recent_events].slice(0, 40),
    generated_at_ms: Date.now(),
  };
}

function normalizeActivity(activity: CopilotActivity): CopilotActivity {
  return {
    ...createEmptyActivity(),
    ...activity,
    sessions: (activity.sessions ?? []).map(session => ({
      ...session,
      recent_tool_calls: session.recent_tool_calls ?? [],
      recent_turns: session.recent_turns ?? [],
    })),
    tools: activity.tools ?? [],
    recent_events: activity.recent_events ?? [],
    alerts: activity.alerts ?? [],
  };
}

function errorOrReview(session: CopilotSessionSummary) {
  return session.status === 'needs-attention' || session.error_count > 0;
}

function eventKey(event: CopilotEventSummary) {
  return `${event.timestamp}|${event.session_id}|${event.kind}|${event.tool}|${event.category}|${event.success}`;
}

function quarterKeyForEvent(event: CopilotEventSummary): MissionCategory | null {
  const category = event.category;
  if (category === 'forge' || category === 'library' || category === 'terminal' || category === 'signal' || category === 'delegates' || category === 'skills' || category === 'court' || category === 'mcp') {
    return category;
  }
  if (category === 'alert') return 'terminal';
  // Non-tool events (assistant.turn_start, thinking, waiting, prompt,
  // arrival, complete, workshop, ...) don't map to any quarter. They
  // still appear in the Activity Feed but we no longer fabricate a
  // pulse — that previously created the illusion of work flowing into
  // Intent (the prior fallthrough) without the count ever changing.
  return null;
}

function pulsePoint(pulse: EventPulse) {
  const p = clamp(pulse.progress, 0, 1);
  if (p < 0.55) {
    const local = p / 0.55;
    return {
      x: pulse.startX + (pulse.midX - pulse.startX) * local,
      y: pulse.startY,
    };
  }
  const local = (p - 0.55) / 0.45;
  return {
    x: pulse.endX,
    y: pulse.startY + (pulse.endY - pulse.startY) * local,
  };
}

function categoryColor(category: string) {
  return QUARTER_COLORS[category as MissionCategory] ?? 0x9aa6c8;
}

function colorToCss(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/// Multiply each RGB channel by `factor` (0..1). Used to derive a
/// darker variant of a quarter color for the light-mode bracket
/// frames — the raw hues wash out at 0.7 alpha on a white backdrop.
function darkenColor(color: number, factor: number): number {
  const r = Math.max(0, Math.min(255, Math.floor(((color >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.floor(((color >> 8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.floor((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

/// In light mode the count number sits on white — bright cyan/yellow
/// don't have enough contrast. Darken those hues for the text color
/// while leaving dark theme alone.
function quarterTextColor(color: number): number {
  return theme.mode === 'light' ? darkenColor(color, 0.55) : color;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number) {
  return Math.round(value);
}

function sceneScale() {
  return clamp(Math.min(W / 1920, H / 1080) * 1.24, 0.88, 1.45);
}

function compactNumber(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

/// Integer-rounded variant of `compactNumber` for tight UI slots where
/// the decimal in "924.8k" would push the string past the available
/// width. "925k" / "1m" instead of "924.8k" / "1.3m".
function compactNumberShort(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatAge(seconds?: number) {
  if (seconds === undefined || Number.isNaN(seconds)) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/// Parses the ISO timestamp Rust emits on each `CopilotEventSummary`
/// and returns the elapsed seconds vs `nowMs`. Falls back to 0 for
/// malformed timestamps so the feed never crashes on bad input.
function eventAgeSeconds(timestamp: string, nowMs = Date.now()): number {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

function feedLabel(event: CopilotEventSummary) {
  if (event.kind === 'tool.execution_start') return event.tool || 'tool started';
  if (event.kind === 'tool.execution_complete') return event.success ? 'tool completed' : 'tool failed';
  if (event.kind === 'assistant.turn_start') return 'Copilot started thinking';
  if (event.kind === 'assistant.turn_end') return 'Copilot is waiting';
  if (event.kind === 'user.message') return 'prompt received';
  if (event.kind === 'session.start') return 'session opened';
  return event.kind;
}

const PREFS_KEY = 'cmc_prefs';

interface MissionPrefs {
  /// Sticky last-hovered quarter. Persists across window restarts so
  /// the inspector resumes on whatever the user was last looking at.
  inspectedQuarterKey?: string | null;
  replayPaused?: boolean;
  lastSelectedSessionId?: string | null;
}

function loadMissionPrefs(): MissionPrefs {
  try {
    const raw = window.localStorage?.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const prefs = parsed as MissionPrefs & {
        // Legacy fields that may still be in old users' localStorage:
        //  - `pinnedDistrictKey`: original click-to-pin key (v0.1).
        //  - `inspectedDistrictKey`: renamed sticky-hover key (v0.1.x).
        // Both fold into `inspectedQuarterKey` when present, and we
        // strip them from storage so they don't linger forever.
        pinnedDistrictKey?: string | null;
        inspectedDistrictKey?: string | null;
      };
      let mutated = false;
      if (prefs.inspectedQuarterKey === undefined || prefs.inspectedQuarterKey === null) {
        if (prefs.inspectedDistrictKey !== undefined && prefs.inspectedDistrictKey !== null) {
          prefs.inspectedQuarterKey = prefs.inspectedDistrictKey;
        } else if (prefs.pinnedDistrictKey !== undefined && prefs.pinnedDistrictKey !== null) {
          prefs.inspectedQuarterKey = prefs.pinnedDistrictKey;
        }
      }
      if (prefs.inspectedDistrictKey !== undefined) {
        delete prefs.inspectedDistrictKey;
        mutated = true;
      }
      if (prefs.pinnedDistrictKey !== undefined) {
        delete prefs.pinnedDistrictKey;
        mutated = true;
      }
      if (mutated) {
        try {
          window.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch { /* ignore — quota/private-mode is non-fatal */ }
      }
      return prefs;
    }
  } catch { /* ignore */ }
  return {};
}

function savePref<K extends keyof MissionPrefs>(key: K, value: MissionPrefs[K]) {
  try {
    const current = loadMissionPrefs();
    current[key] = value;
    window.localStorage?.setItem(PREFS_KEY, JSON.stringify(current));
  } catch { /* ignore — quota/private-mode is non-fatal */ }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}
