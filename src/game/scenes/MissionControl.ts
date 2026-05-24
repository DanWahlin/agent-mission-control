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
}

interface SessionToolCall {
  tool: string;
  category: string;
  timestamp: string;
  success: boolean;
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
  rightW: number;
  rightX: number;
  insightH: number;
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
  }
}

const GOLD = 0xffd54a;
const TS_ASSET_ROOT = '../assets/kingdom/tiny-swords';

type ThemeMode = 'dark' | 'light';
interface MissionTheme {
  mode: ThemeMode;
  backdropFill: number;
  panelBg: number;
  panelBgAlpha: number;
  panelStroke: number;
  panelStrokeAlpha: number;
  panelGradientTop: number;
  cardBg: number;
  cardBgAlpha: number;
  text: string;
  muted: string;
  rowBg: number;
}

const DARK_THEME: MissionTheme = {
  mode: 'dark',
  backdropFill: 0x05081a,
  panelBg: 0x0a1024,
  panelBgAlpha: 0.94,
  panelStroke: 0x1c2750,
  panelStrokeAlpha: 0.9,
  panelGradientTop: 0x101a3a,
  cardBg: 0x101833,
  cardBgAlpha: 0.9,
  text: '#e8ecff',
  muted: '#93a4d8',
  rowBg: 0x101833,
};

const LIGHT_THEME: MissionTheme = {
  mode: 'light',
  backdropFill: 0xeef2fb,
  panelBg: 0xffffff,
  panelBgAlpha: 0.96,
  panelStroke: 0xc6cfe6,
  panelStrokeAlpha: 1,
  panelGradientTop: 0xf6f8fd,
  cardBg: 0xe7ecf6,
  cardBgAlpha: 0.95,
  text: '#1a2240',
  muted: '#5b6a8f',
  rowBg: 0xdde3f1,
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
  forge: 'ts-house-red',
  library: 'ts-tower-blue',
  terminal: 'ts-tower-purple',
  signal: 'ts-tower-yellow',
  delegates: 'ts-castle-red',
  skills: 'ts-house-purple',
  court: 'ts-castle-yellow',
  mcp: 'ts-house-blue',
};

/// Single source of truth for quarter hues. Both `buildQuarters` and
/// `categoryColor` read from this map — previously they each had their
/// own hex literals which silently drifted apart whenever one was
/// tweaked. The 'alert' entry is shared with the attention/error pulse
/// path and is intentionally not a quarter.
const QUARTER_COLORS: Record<MissionCategory, number> = {
  forge: 0xff8a3d,
  library: 0x61d6ff,
  terminal: 0xa5ff6b,
  signal: 0xb88cff,
  delegates: 0xff6bd6,
  skills: 0xc56bff,
  court: 0xffd54a,
  mcp: 0x4ad6a8,
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
  private ui!: any;
  private flow!: any;
  private overlay!: any;
  /// Cached castle geometry so update() can re-draw the animated moat
  /// pulse every frame without recomputing layout. Populated by
  /// drawCastle() each renderActivity() pass; null until first draw.
  private moatGeometry: { x: number; y: number; radius: number; active: boolean } | null = null;
  private textObjects: any[] = [];
  // Text objects owned by the transcript overlay. Kept separate from
  // `textObjects` so wheel-scrolling can rebuild only the transcript
  // rows without tearing down every Phaser.GameObjects.Text in the
  // scene (full re-render is ~120 destroy+create operations and was
  // the root cause of laggy scroll). `clearDynamicObjects()` also
  // destroys these so the standard render path stays correct.
  private transcriptTextObjects: any[] = [];
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
  private replayTrackRect: { x: number; y: number; w: number; h: number } | null = null;
  private replayPlayButtonRect: { x: number; y: number; w: number; h: number } | null = null;
  private replayLiveButtonRect: { x: number; y: number; w: number; h: number } | null = null;
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
  private audioCtx?: AudioContext;
  /// One-shot guard: we play at most one chime per app session. After
  /// the first turn-end or attention chime we suppress every subsequent
  /// one — recurring bells get annoying fast for a passive monitor.
  private chimePlayedThisSession = false;
  /// Modal panel hit rects, populated during render when the transcript
  /// drill-down is open.
  private transcriptCloseRect: { x: number; y: number; w: number; h: number } | null = null;
  private transcriptToggleRect: { x: number; y: number; w: number; h: number } | null = null;
  private openInEditorRect: { x: number; y: number; w: number; h: number } | null = null;
  private transcriptOpen = false;
  private transcriptScrollOffset = 0;
  private transcriptRowsVisible = 0;
  private transcriptRowCount = 0;
  private transcriptScrollUpRect: { x: number; y: number; w: number; h: number } | null = null;
  private transcriptScrollDownRect: { x: number; y: number; w: number; h: number } | null = null;
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
    this.load.image('ts-castle-blue', `${TS_ASSET_ROOT}/buildings/castle-blue.png`);
    this.load.image('ts-castle-red', `${TS_ASSET_ROOT}/buildings/castle-red.png`);
    this.load.image('ts-castle-yellow', `${TS_ASSET_ROOT}/buildings/castle-yellow.png`);
    this.load.image('ts-house-blue', `${TS_ASSET_ROOT}/buildings/house-blue.png`);
    this.load.image('ts-house-purple', `${TS_ASSET_ROOT}/buildings/house-purple.png`);
    this.load.image('ts-house-red', `${TS_ASSET_ROOT}/buildings/house-red.png`);
    this.load.image('ts-house-yellow', `${TS_ASSET_ROOT}/buildings/house-yellow.png`);
    this.load.image('ts-tower-blue', `${TS_ASSET_ROOT}/buildings/tower-blue.png`);
    this.load.image('ts-tower-purple', `${TS_ASSET_ROOT}/buildings/tower-purple.png`);
    this.load.image('ts-tower-yellow', `${TS_ASSET_ROOT}/buildings/tower-yellow.png`);
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
    this.ui = this.add.graphics().setDepth(10);
    // Modal overlays (transcript drill-down) sit above quarter labels
    // and badges (depth 20-21) so they fully occlude what's behind them.
    this.overlay = this.add.graphics().setDepth(50);

    // Restore last-session prefs so context survives a window restart.
    // The migration in loadMissionPrefs() folds older `pinnedDistrictKey`
    // and `inspectedDistrictKey` storage entries into the new key.
    const prefs = loadMissionPrefs();
    this.inspectedQuarterKey = prefs.inspectedQuarterKey ?? null;
    if (prefs.replayPaused) this.replayPaused = true;
    if (prefs.transcriptOpen) this.transcriptOpen = true;
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

    // Scene-level pointer dispatcher: avoids the Phaser quirk where
    // destroying an interactive zone while the pointer is over it can
    // leave a stale `over` reference, blocking the next click. Hit-tests
    // rect data stored on the scene so re-renders don't churn input
    // objects.
    this.input.on('pointerdown', this.handleScenePointerDown, this);
    // Wheel scrolling for the transcript drill-down. Phaser fires this
    // for any wheel event on the canvas; we guard so it only acts when
    // the transcript is open. Wheel delta is mapped to rows so a
    // single notch (dy ≈ 100 on a mouse, 16-40 on a trackpad) jumps
    // ~3 rows instead of 1 — matches browser scroll feel.
    this.input.on('wheel', (_p: any, _go: any, _dx: number, dy: number) => {
      if (!this.transcriptOpen) return;
      if (dy === 0) return;
      const rows = Math.max(1, Math.round(Math.abs(dy) / 30));
      this.adjustTranscriptScroll(Math.sign(dy) * rows);
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
    const pointer = this.input?.activePointer;
    if (!pointer) return;
    const px = pointer.x;
    const py = pointer.y;
    let over = false;
    if (this.transcriptOpen) {
      // While modal is open, only the close button is interactive.
      if (this.hitRect(px, py, this.transcriptCloseRect)) over = true;
    } else {
      for (const row of this.sessionPickerRows) {
        if (this.hitRect(px, py, row)) { over = true; break; }
      }
      if (!over && this.hitRect(px, py, this.replayPlayButtonRect)) over = true;
      if (!over && this.hitRect(px, py, this.replayLiveButtonRect)) over = true;
      if (!over && this.replayTrackRect && this.eventLog.length > 0 && this.hitRect(px, py, this.replayTrackRect)) over = true;
      if (!over && this.hitRect(px, py, this.openInEditorRect)) over = true;
      if (!over && this.hitRect(px, py, this.transcriptToggleRect)) over = true;
      if (!over && this.hoveredQuarterIndex >= 0) over = true;
    }
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
    this.input?.off?.('pointerdown', this.handleScenePointerDown, this);
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
    // Blank the navbar model chip so a stale model id doesn't linger
    // when the scene tears down (game switch, hot reload, etc.).
    try { window.__cmcUpdateModel?.(''); } catch { /* no-op */ }
    this.clearDynamicObjects();
    this.flow?.clear();
    this.moat?.clear();
    this.overlay?.clear();
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
    if (this.audioCtx) {
      try { void this.audioCtx.close(); } catch { /* ignore */ }
      this.audioCtx = undefined;
    }
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
    this.ui.clear();
    this.overlay.clear();

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
    this.drawPanels();
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
        ? Math.min(320, Math.max(260, W * 0.24))
        : Math.min(500, Math.max(360, W * 0.28));
    const rightW = this.panelsHidden
      ? 0
      : compact
        ? Math.min(340, Math.max(280, W * 0.26))
        : Math.min(500, Math.max(380, W * 0.28));
    const rightX = this.panelsHidden ? W - leftX : W - rightW - leftX;

    const insightH = Math.min(compact ? 370 : 450, Math.max(310, H * 0.42));
    // sessionH floor must accommodate picker header (22) + pickerTop offset
    // (22) + at least one row (28) + footer (14) + reserved details block
    // (168) + margin → ~294. Compact cap bumped accordingly so the row
    // strip and details stop overlapping at 1024×768 and 1280×800.
    const sessionH = Math.min(compact ? 320 : 360, Math.max(294, H * 0.32));

    // Replay strip is hidden in focus mode so the quarter inspector
    // can drop to the bottom edge and the mission ring picks up the
    // recovered vertical room. replayY is parked off-canvas so any
    // stale rect references read as out-of-bounds (the strip is also
    // never drawn — see drawPanels).
    const replayH = this.panelsHidden ? 0 : (compact ? 48 : 56);
    const replayMargin = Math.max(12, H * 0.016);
    const replayY = this.panelsHidden ? H : H - replayH - replayMargin;

    // Bottom inspector lives between the side panels, just above the
    // replay strip. Floor bumped to 112 so the title bar (34) + count
    // line + stats line + footer have room without footer text spilling
    // below the panel border at 1024×768.
    const bottomH = Math.min(compact ? 144 : 168, Math.max(132, H * 0.15));
    const replayGap = 12;
    // In focus mode the inspector hugs the bottom edge directly
    // (replayMargin only) since the replay strip isn't there to sit
    // above. Otherwise it floats above the replay strip with replayGap
    // breathing room.
    const bottomY = this.panelsHidden
      ? H - bottomH - replayMargin
      : replayY - replayGap - bottomH;

    const inspectorGutter = compact ? 20 : 32;
    const inspectorX = leftX + panelW + inspectorGutter;
    const inspectorW = Math.max(360, rightX - inspectorX - inspectorGutter);

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
    const wellRight = rightX - wellGutterX;
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
    // ~46*pedestalUnit (halo bottom) + 14 + labelSize + countSize px
    // (see drawQuarters). Using the same pedestalUnit (quarterR/64)
    // here as the halo math there means labels follow when focus-mode
    // grows the sprites.
    const labelStackH = Math.round(46 * (quarterR / 64) + 14 + Math.max(14, quarterR * 0.22) + Math.max(18, quarterR * 0.26));

    // The top quarter (Edits) only needs `quarterR` of clearance
    // above its center, while the bottom quarter (Agents) needs
    // `labelStackH` for its label stack. That asymmetry wastes vertical
    // space when we use the smaller of the two for radiusY. Instead,
    // shift the ring's geometric center UP by half the asymmetry so
    // the top and bottom clearance requirements balance — radiusY can
    // then grow to use the freed space. Focus mode only; panels-visible
    // layout has been signed off and we don't disturb it.
    const verticalShift = this.panelsHidden
      ? Math.max(0, (labelStackH - quarterR) / 2)
      : 0;
    const centerY = wellTop + wellH / 2 - verticalShift;

    const radiusY = this.panelsHidden
      ? Math.max(100, rawRadiusY - (labelStackH + quarterR) / 2)
      : Math.max(100, rawRadiusY - Math.max(quarterR, labelStackH));

    // In focus mode the well is much wider than tall (no side panels),
    // so an unconstrained radiusX puts the side quarters far from the
    // castle and breaks the ring feel. Cap radiusX so the ellipse stays
    // closer to a circle. 1.4:1 is the sweet spot — tighter (1.3)
    // crowds the castle halo on smaller viewports, looser (1.5+) starts
    // to look elongated on wide ones.
    const radiusXCap = this.panelsHidden ? radiusY * 1.4 : Infinity;
    const radiusX = Math.max(120, Math.min(rawRadiusX - quarterR, radiusXCap));
    const topLift = Math.min(quarterR * 0.6, Math.max(0, wellTop - opsY - opsH - quarterR * 1.4));

    return {
      s, compact,
      leftX, opsY, opsH, topY, panelW,
      rightW, rightX,
      insightH, sessionH,
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

  /// Return a 24-bucket sparkline for the given work-mix category, one
  /// bucket per hour. Trims the history buffer in place.
  private workMixSparkline(category: string): number[] {
    const buckets: number[] = new Array(24).fill(0);
    const arr = this.workMixHistory[category];
    if (!arr || arr.length === 0) return buckets;
    const now = performance.now();
    const cutoff = now - 24 * 60 * 60_000;
    while (arr.length > 0 && arr[0].perfTs < cutoff) arr.shift();
    for (const entry of arr) {
      const hoursAgo = Math.floor((now - entry.perfTs) / 60_000 / 60);
      if (hoursAgo >= 0 && hoursAgo < buckets.length) {
        buckets[buckets.length - 1 - hoursAgo] += 1;
      }
    }
    return buckets;
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
    const { centerX, centerY, s, quarterSize, quarterR, topLift } = layout;
    // Castle Y is biased slightly below centerY so the castle visually
    // sits inside the ring of buildings. Each quarter card also has a
    // ~38px label block below its sprite that pushes the *visible*
    // bottom of the layout further down than the geometric ring, and
    // Edits is lifted upward by `topLift` which pulls the geometric
    // centroid above centerY. Both effects bias the eye downward; we
    // counter by sliding the castle down by half the topLift plus a
    // small fraction of the quarter size.
    const castleY = centerY + topLift * 0.5 + quarterSize * 0.12;
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
      const labelBlockH = Math.round(38 * Math.max(s, 0.85));
      const frameH = size + labelBlockH;
      const light = theme.mode === 'light';
      const liveOuter = light ? (focused ? 0.55 : 0.34) : (focused ? 0.7 : 0.5);
      const liveInner = light ? (focused ? 0.78 : 0.55) : (focused ? 0.92 : 0.75);
      // Every quarter renders with the same colored pedestal regardless
      // of 24h activity count. We used to dim idle quarters to a grey
      // wash, but that read as a visual "bug" against the surrounding
      // active quarters — the activity badge in the corner already
      // signals zero activity, so the desaturation was redundant noise.
      const outerAlpha = liveOuter;
      const innerAlpha = liveInner;
      const pedestalColor = quarter.color;
      // Draw the panel/backdrop FIRST so the colored pedestal circles
      // can layer on top of it in dark mode. (Previously the outer
      // circle was drawn first and then the near-opaque dark panel
      // covered it, which is why the colored halos that were so
      // visible in light mode disappeared in dark mode.) Light mode
      // skips the panel fill entirely, so the circles still read
      // directly against the mission backdrop.
      this.drawPixelPanel(quarter.x - size / 2, panelTop, size, frameH, quarter.color, focused, s);
      // Halo circles scale with quarterR (via pedestalUnit) instead of
      // raw scene scale so they keep their visual proportion when
      // focus-mode bumps the quarter sprite size. labelStackH in
      // computeLayout uses the same unit so labels follow.
      const pedestalUnit = quarterR / 64;
      this.map.fillStyle(pedestalColor, outerAlpha);
      this.map.fillCircle(quarter.x, quarter.y - 8 * pedestalUnit, 54 * pedestalUnit);
      this.map.fillStyle(pedestalColor, innerAlpha);
      this.map.fillCircle(quarter.x, quarter.y - 18 * pedestalUnit, 30 * pedestalUnit);
      const texture = QUARTER_TEXTURES[quarter.key] ?? 'ts-house-blue';
      const spriteW = size * 0.52;
      const spriteH = size * 0.74;
      const sprite = this.add.image(quarter.x, panelTop + size * 0.36, texture)
        .setOrigin(0.5, 0.62)
        .setDepth(7)
        .setAlpha(focused ? 1 : 0.9);
      sprite.setDisplaySize(spriteW, spriteH);
      this.textObjects.push(sprite);
      const labelSize = Math.max(10, Math.round(size * 0.1));
      const countSize = Math.max(13, Math.round(size * 0.13));
      // Place the label just below the visible halo (which now scales
      // with quarterR via pedestalUnit) with a small breathing gap so
      // text never overlaps the disc.
      const labelY = quarter.y + 46 * pedestalUnit + 8 + labelSize / 2;
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
    // Bracket color: in light mode the raw quarter hues (light cyan,
    // soft yellow, lavender) wash out at full saturation on a white
    // backdrop, so they get darkened. In dark mode the hues read fine
    // as-is.
    const bracketColor = theme.mode === 'light' ? darkenColor(color, 0.55) : color;
    const bracketAlpha = focused ? 1 : 0.9;
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

  private drawQuarterActivityBadge(
    quarter: Quarter,
    panelTop: number,
    size: number,
    s: number,
  ) {
    const stats = this.getQuarterSessionStats(quarter.key);
    if (stats.total === 0) return;
    const badgeColor = stats.review > 0 ? 0xff5252 : stats.active > 0 ? 0x60ff9a : 0x8c9ac8;
    const badgeX = quarter.x + size / 2 - 18 * s;
    const badgeY = panelTop + 18 * s;
    const badgeSize = 26 * s;
    const border = Math.max(2, Math.round(2 * s));
    this.map.fillStyle(0x020713, 0.86);
    this.map.fillRect(snap(badgeX - badgeSize / 2), snap(badgeY - badgeSize / 2), snap(badgeSize), snap(badgeSize));
    this.map.fillStyle(badgeColor, 0.95);
    this.map.fillRect(snap(badgeX - badgeSize / 2), snap(badgeY - badgeSize / 2), snap(badgeSize), border);
    this.map.fillRect(snap(badgeX - badgeSize / 2), snap(badgeY + badgeSize / 2 - border), snap(badgeSize), border);
    this.map.fillRect(snap(badgeX - badgeSize / 2), snap(badgeY - badgeSize / 2), border, snap(badgeSize));
    this.map.fillRect(snap(badgeX + badgeSize / 2 - border), snap(badgeY - badgeSize / 2), border, snap(badgeSize));
    const display = stats.review > 0 ? `!${stats.review}` : String(stats.active);
    this.addText(badgeX, badgeY - 5 * s, display, Math.round(8 * s), colorToCss(badgeColor)).setOrigin(0.5, 0);
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

    // (x, y) is the layout center. Castle artwork sits with its visual
    // mass biased toward the upper portion, so we shift the sprite anchor
    // slightly above y. Combined with the pill below, the castle + pill
    // stack reads as centered inside the moat disk.
    const moatCx = x;
    const moatCy = y;
    const moatOuterR = 132 * castleScale;
    // Faint surrounding glow so the moat reads as water, not a flat circle.
    this.map.fillStyle(0x1d2a5a, 0.42);
    this.map.fillCircle(moatCx, moatCy, moatOuterR + 4);
    // Water body — solid blue disk filling the entire moat circle.
    this.map.fillStyle(0x2960c0, 0.62);
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

    const castle = this.add.image(x, y - 10 * castleScale, 'ts-castle-blue')
      .setOrigin(0.5, 0.62)
      .setDepth(6);
    castle.setDisplaySize(210 * castleScale, 168 * castleScale);
    this.textObjects.push(castle);
    // Active-sessions badge — sits in the moat just below the castle.
    // With sprite anchor at y - 10s, sprite bottom = y + 54*castleScale.
    const pillW = Math.max(88, 96 * castleScale);
    const pillH = Math.max(28, 32 * castleScale);
    const pillX = x - pillW / 2;
    const pillY = y + 64 * castleScale;
    const activeFill = active > 0 ? 0x2d6cb0 : 0x2a3556;
    // Pill keeps the same blue background in both themes, so the text
    // can stay white/light for high contrast regardless of mode.
    const activeText = active > 0 ? '#ffffff' : '#c8d2e8';
    const activeLabel = active > 0 ? '#dfeaff' : '#7d88ad';
    this.map.fillStyle(0x0a1438, 0.55);
    this.map.fillRoundedRect(pillX + 2, pillY + 3, pillW, pillH, pillH / 2);
    this.map.fillStyle(activeFill, 1);
    this.map.fillRoundedRect(pillX, pillY, pillW, pillH, pillH / 2);
    this.map.lineStyle(Math.max(1, Math.round(1.5 * castleScale)), 0x9bd2ff, 0.55);
    this.map.strokeRoundedRect(pillX, pillY, pillW, pillH, pillH / 2);
    const labelSize = Math.max(8, Math.round(9 * castleScale));
    const countSize = Math.max(14, Math.round(16 * castleScale));
    const textCy = pillY + pillH / 2;
    this.addText(x - pillW * 0.22, textCy, 'ACTIVE', labelSize, activeLabel).setOrigin(0.5);
    this.addText(x + pillW * 0.28, textCy, String(active), countSize, activeText).setOrigin(0.5);
  }

  private drawPanels() {
    const layout = this.layout!;
    const { leftX, topY, panelW, rightW, rightX,
            insightH, sessionH, replayH, replayY, bottomH, bottomY,
            inspectorX, inspectorW, compact } = layout;

    // Ops strip is no longer drawn on the canvas — its status word,
    // recommendation, and alert count are surfaced in the top bar via
    // window.__cmcUpdateOps (see renderActivity + hud.js).

    // Focus mode skips the three side panels (Summary / Selected
    // Session / Activity Feed) so the mission ring expands to fill
    // the canvas. The bottom quarter inspector + replay timeline at
    // the end of this method still draw so hover/click + scrubber
    // controls keep working.
    if (!this.panelsHidden) {
    this.drawPanel(leftX, topY, panelW, insightH, 'Summary');
    // 4-card 2x2 grid sized to fit above the work-mix bars block.
    const cardGap = compact ? 8 : 12;
    const cardCols = 2;
    const cardRows = Math.ceil(this.insightCards.length / cardCols);
    // Bars block: header + 6 rows (Read/Edit/Cmd/Web/Agent/MCP) of
    // (compact 18px / normal 22px) + bottom gap. Keep the row count in
    // sync with `drawWorkMixBars` — that's the single source of truth
    // for which categories appear here.
    const barRowPitch = compact ? 16 : 20;
    const barsHeaderH = compact ? 20 : 26;
    const barsBottomGap = compact ? 10 : 14;
    const barRowCount = 6;
    const barsContentH = barsHeaderH + barRowCount * barRowPitch + barsBottomGap;
    const cardsAreaH = Math.max(120, insightH - 64 - barsContentH - 16);
    const cardH = Math.max(64, Math.min(94, (cardsAreaH - cardGap * (cardRows - 1)) / cardRows));
    const cardW = (panelW - 36 - cardGap) / cardCols;
    for (let i = 0; i < this.insightCards.length; i++) {
      const card = this.insightCards[i];
      const col = i % cardCols;
      const row = Math.floor(i / cardCols);
      const x = leftX + 18 + col * (cardW + cardGap);
      const y = topY + 64 + row * (cardH + cardGap);
      this.drawInsightCard(x, y, cardW, cardH, card);
    }
    // Anchor the bars block to the BOTTOM of the panel so the last "Agent"
    // row always sits inside the panel border regardless of compact mode.
    const barsY = topY + insightH - barsContentH + 8;
    this.drawWorkMixBars(leftX + 20, barsY, panelW - 40, barRowPitch, barsHeaderH);

    this.drawSessionInspector(rightX, topY, rightW, sessionH);

    // Activity Feed grows to fill the right column; alerts moved into
    // the top ops strip so they don't steal vertical real estate here.
    const feedY = topY + sessionH + (compact ? 14 : 22);
    const feedH = Math.max(140, bottomY - feedY - 16);
    this.drawPanel(rightX, feedY, rightW, feedH, this.isAtLive() ? 'Activity Feed' : 'Activity Feed · replay view');
    const visibleLog = this.eventLog.slice(0, this.replayCursor);
    // Drop anything older than FADE_END_S so the feed self-prunes
    // — old rows fade in for the last ~4 min of their lifetime, then
    // disappear. Replay timeline is unaffected (it uses eventLog
    // directly, not the filtered feed).
    const FADE_START_S = 60;
    const FADE_END_S = 300;
    const nowMs = Date.now();
    const enrichedFeed = visibleLog.slice(-30).reverse().map(event => ({
      event,
      ageS: eventAgeSeconds(event.timestamp, nowMs),
    })).filter(({ ageS }) => ageS <= FADE_END_S);
    const feed = enrichedFeed;
    if (feed.length === 0) {
      const message = this.activity.available
        ? 'No recent Copilot events found. Start a Copilot CLI session and this mission control will wake up.'
        : 'Copilot CLI was not detected. Install or run Copilot CLI to populate this mission.';
      this.addWrappedText(rightX + 22, feedY + 58, message, rightW - 44, 13, theme.muted);
    } else {
      // Slim per-row pitch (32 px) so compact layouts can show multiple
      // events without overflowing the panel border. Cap visible rows
      // to whatever the panel can actually accommodate — never force
      // more than fit (previous Math.max(4, …) caused 1280×800 spills).
      const rowPitch = 32;
      const rowTopOffset = 56;
      const bottomPadding = 14;
      const maxRows = Math.max(1, Math.floor((feedH - rowTopOffset - bottomPadding) / rowPitch));
      const visibleFeed = feed.slice(0, maxRows);
      for (let i = 0; i < visibleFeed.length; i++) {
        const { event, ageS } = visibleFeed[i];
        const y = feedY + rowTopOffset + i * rowPitch;
        const color = event.success ? categoryColor(event.category) : 0xff5252;
        // Linear fade between FADE_START_S and FADE_END_S, floored at
        // 0.2 so a row stays just visible right before it drops out.
        const fadeT = Math.max(0, Math.min(1, (ageS - FADE_START_S) / (FADE_END_S - FADE_START_S)));
        const alpha = 1 - fadeT * 0.8;
        this.ui.fillStyle(color, 0.16 * alpha);
        this.ui.fillRoundedRect(rightX + 18, y - 4, rightW - 36, 26, 8);
        this.ui.fillStyle(color, alpha);
        this.ui.fillCircle(rightX + 34, y + 9, 5);
        this.addText(rightX + 48, y, feedLabel(event), 12, theme.text).setOrigin(0, 0).setAlpha(alpha);
        this.addText(rightX + rightW - 22, y, `${formatAge(ageS)} ago`, 10, theme.muted).setOrigin(1, 0).setAlpha(alpha);
      }
    }
    } // end if (!this.panelsHidden)

    this.drawQuarterInspector(inspectorX, bottomY, inspectorW, bottomH);

    // Replay strip is hidden in focus mode — drawReplayTimeline also
    // populates the play/live/track rects that the click handler
    // reads, so leave them null when skipped.
    if (this.panelsHidden) {
      this.replayPlayButtonRect = null;
      this.replayLiveButtonRect = null;
      this.replayTrackRect = null;
    } else {
      this.drawReplayTimeline(leftX, replayY, W - leftX * 2, replayH);
    }

    // Transcript drill-down sits on top of everything so it can occlude
    // panels while the user reviews a session.
    if (this.transcriptOpen && this.selectedSession) {
      this.drawTranscriptOverlay();
    } else {
      this.transcriptCloseRect = null;
    }
  }

  private drawInsightCard(x: number, y: number, w: number, h: number, card: InsightCard) {
    this.ui.fillStyle(theme.cardBg, 0.9);
    this.ui.fillRoundedRect(x, y, w, h, 10);
    this.ui.lineStyle(1, 0x31437a, 0.8);
    this.ui.strokeRoundedRect(x, y, w, h, 10);

    // Hybrid grid layout: label anchored to the TOP, sub anchored to
    // the BOTTOM, value centered between them. This keeps the label
    // and sub at consistent absolute offsets from the card edges
    // (which is what reads as "aligned" across cards in the grid)
    // while letting the value flex to occupy the middle regardless of
    // cardH (which compresses to ~56 px at 1280×800 compact and
    // expands to ~82 px at non-compact sizes). setOrigin(_, 0.5)
    // anchors each row by its vertical center so font-metric
    // variations between "1" / "258" / "767k" can't drift the
    // baseline visibly.
    const padX = 12;
    const labelY = y + 14;
    const subY = y + h - 12;
    const valueY = (labelY + subY) / 2;

    this.addText(x + padX, labelY, card.label, 13, theme.muted).setOrigin(0, 0.5);

    const valueSize = h >= 70 ? 22 : 18;
    this.addText(x + padX, valueY, truncate(card.value, 12), valueSize, card.color ?? theme.text).setOrigin(0, 0.5);

    if (card.sub) {
      // Press Start 2P is monospace with advance ≈ fontSize, so
      // fontSize 12 renders ~12 px per char — use that to truncate
      // accurately so the string never overruns the rounded border.
      // The Tokens sub uses `compactNumberShort` ("925k" vs "924.8k")
      // so even a narrow 1280×800 card (inner width ~107 px → ~8
      // chars) shows the full "925k/331k" without trailing ellipsis.
      // If the verbose form ("12m in · 2m out") doesn't fit, fall
      // back to the compact "in/out" form ("12m/2m") which is always
      // ≤ 9 chars even with millions on both sides.
      const subMaxChars = Math.max(8, Math.floor((w - padX * 2) / 12));
      let subText = card.sub;
      if (subText.length > subMaxChars && card.subCompact) {
        subText = card.subCompact;
      }
      this.addText(x + padX, subY, truncate(subText, subMaxChars), 12, theme.muted).setOrigin(0, 0.5);
    }
  }

  private drawWorkMixBars(x: number, y: number, w: number, rowPitch = 22, headerOffset = 28) {
    const mix = workMix(this.activity);
    const rows: [string, number, number][] = [
      ['Read', mix.read, categoryColor('library')],
      ['Edit', mix.write, categoryColor('forge')],
      ['Cmd', mix.command, categoryColor('terminal')],
      ['Web', mix.web, categoryColor('signal')],
      ['Agent', mix.task, categoryColor('delegates')],
      ['MCP', mix.mcp, categoryColor('mcp')],
    ];
    const max = Math.max(1, ...rows.map(([, value]) => value));
    const barH = Math.min(12, rowPitch - 6);
    this.addText(x, y, 'Recent work mix · last 24h', 12, theme.muted).setOrigin(0, 0);
    const countLabelW = 36;
    const barX = x + 78;
    const barEndX = x + w - countLabelW - 6;
    const barAvailW = Math.max(40, barEndX - barX);
    const trackRadius = 6;
    const cap = barH / 2;
    for (let i = 0; i < rows.length; i++) {
      const [label, value, color] = rows[i];
      const rowY = y + headerOffset + i * rowPitch;
      this.addText(x, rowY - 1, label, 11, theme.text).setOrigin(0, 0);
      this.ui.fillStyle(0x1a2448, 0.82);
      this.ui.fillRoundedRect(barX, rowY, barAvailW, barH, trackRadius);
      this.ui.fillStyle(color, 0.95);
      // Min fill width = barH so the rounded left cap always has room
      // to render as a full half-circle (otherwise it gets clipped and
      // looks like a jagged sliver).
      const fillW = Math.max(barH, barAvailW * (value / max));
      if (fillW >= barAvailW - 0.5) {
        this.ui.fillRoundedRect(barX, rowY, fillW, barH, trackRadius);
      } else {
        // Partial fill: smooth rounded left cap via fillCircle (uses
        // many segments, so it doesn't pixelate at small widths the way
        // fillRoundedRect's tessellated corners do) + flat-right body
        // from the cap's center across the remaining width.
        this.ui.fillCircle(barX + cap, rowY + cap, cap);
        this.ui.fillRect(barX + cap, rowY, fillW - cap, barH);
      }
      this.addText(barX + barAvailW + 6, rowY - 3, String(value), 11, theme.muted).setOrigin(0, 0);
    }
  }

  /// Tiny inline bar sparkline. Used by work-mix rows for 24h history
  /// and by the castle area for 10-min tool-call rate.
  private drawSparkline(x: number, y: number, w: number, h: number, buckets: number[], color: number) {
    if (buckets.length === 0) return;
    const max = Math.max(1, ...buckets);
    const bw = w / buckets.length;
    const innerH = h - 2;
    this.ui.fillStyle(0x1a2448, 0.5);
    this.ui.fillRect(snap(x), snap(y), snap(w), snap(h));
    for (let i = 0; i < buckets.length; i++) {
      const v = buckets[i];
      if (v === 0) continue;
      const bh = Math.max(1, (v / max) * innerH);
      this.ui.fillStyle(color, 0.85);
      this.ui.fillRect(snap(x + i * bw + 1), snap(y + h - bh - 1), snap(Math.max(1, bw - 1.5)), snap(bh));
    }
  }

  private drawSessionInspector(x: number, y: number, w: number, h: number) {
    this.drawPanel(x, y, w, h, 'Selected Session');
    const sessionOptions = this.getSessionPickerOptions();
    // Picker only lists actively running sessions; idle/closed sessions
    // are summarized in the footer so the list stays scannable and the
    // header label ("Running sessions") stays truthful.
    const activeOptions = sessionOptions.filter(({ session }) => session.is_active);
    const pickerOptions = activeOptions.length > 0 ? activeOptions : sessionOptions.slice(0, 1);
    const idleCount = Math.max(0, sessionOptions.length - pickerOptions.length);
    const headerLabel = activeOptions.length > 0
      ? `Running sessions (${activeOptions.length})`
      : 'Recent sessions (none active)';
    this.addText(x + 22, y + 56, headerLabel, 12, theme.muted).setOrigin(0, 0);
    if (sessionOptions.length === 0) {
      this.addWrappedText(x + 22, y + 82, 'No running Copilot sessions found. Start Copilot CLI and this panel will show the active task.', w - 44, 13, theme.muted);
      return;
    }

    // Picker rows flow from a fixed top; details + actions flow right
    // after the picker so there's never a big empty gap below the last
    // selected session.
    const rowH = 30;
    const pickerTop = y + 80;
    const maxRowsHardCap = 5;
    const visibleSessions = pickerOptions.slice(0, maxRowsHardCap);
    for (let i = 0; i < visibleSessions.length; i++) {
      const { session, index } = visibleSessions[i];
      const rowY = pickerTop + i * rowH;
      const selected = index === this.selectedSessionIndex;
      const rowColor = statusColor(session.status);
      this.ui.fillStyle(selected ? rowColor : theme.cardBg, selected ? 0.28 : 0.82);
      this.ui.fillRoundedRect(x + 18, rowY - 4, w - 36, 26, 8);
      this.ui.lineStyle(selected ? 2 : 1, rowColor, selected ? 0.9 : 0.44);
      this.ui.strokeRoundedRect(x + 18, rowY - 4, w - 36, 26, 8);
      this.ui.fillStyle(rowColor, session.is_active ? 1 : 0.58);
      this.ui.fillCircle(x + 34, rowY + 9, 5);
      // Press Start 2P is monospace with advance ≈ 1em, so use the
      // font size as the per-character width. Older 7.4/7.6 estimates
      // were way under, letting the title overrun the chip and the
      // chip slip past the panel's right edge. The hash gets ~8 px of
      // internal padding inside the row pill (so it doesn't sit flush
      // against the right border).
      const idLabel = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
      const idWidth = idLabel.length * 10;
      const hashRightInset = 26;
      const titleStart = x + 48;
      const titleEnd = x + w - idWidth - hashRightInset - 8;
      const titleChars = Math.max(10, Math.floor((titleEnd - titleStart) / 12));
      this.addText(titleStart, rowY + 9, truncate(session.title || session.id, titleChars), 12, theme.text).setOrigin(0, 0.5);
      // Hash chip: dark pill behind the id so it stays readable against
      // any row tint (the selected-row fill can be green, yellow, or
      // red depending on session.status, and a plain muted-grey hash
      // washes out against the lighter tints). Both the chip rect and
      // the text use the same `hashCenterX` so the glyphs sit dead-
      // center horizontally regardless of the stroke padding that
      // Phaser includes in the text bounding box.
      const hashChipW = idWidth + 14;
      const hashChipH = 18;
      const hashCenterX = x + w - hashRightInset - idWidth / 2;
      const hashChipX = hashCenterX - hashChipW / 2;
      const hashChipY = rowY + 9 - hashChipH / 2;
      this.ui.fillStyle(0x020713, theme.mode === 'light' ? 0.6 : 0.7);
      this.ui.fillRoundedRect(hashChipX, hashChipY, hashChipW, hashChipH, 4);
      this.addText(hashCenterX, rowY + 9, idLabel, 10, '#e6ecf8').setOrigin(0.5, 0.5);
      this.sessionPickerRows.push({ id: session.id, x: x + 18, y: rowY - 4, w: w - 36, h: 26 });
    }
    const extraActive = pickerOptions.length - visibleSessions.length;
    const overflowParts: string[] = [];
    if (extraActive > 0) overflowParts.push(`+${extraActive} more active`);
    if (idleCount > 0) overflowParts.push(`${idleCount} idle`);
    let pickerBottom = pickerTop + visibleSessions.length * rowH + 4;
    if (overflowParts.length > 0) {
      this.addText(x + 22, pickerBottom, overflowParts.join(' · '), 10, theme.muted).setOrigin(0, 0);
      pickerBottom += 18;
    }

    const session = this.selectedSession;
    if (!session) {
      return;
    }

    // Details flow right after the picker (with a 16px gap) instead of
    // anchoring to the panel bottom — keeps the eye close to the
    // selected session and avoids the big empty gap that resulted from
    // removing the duplicated title/repo lines.
    const detailsY = pickerBottom + 16;
    const status = statusTextColor(session.status);
    // Press Start 2P advance ≈ 1em → at fontSize 13, ~13px per char.
    // Compute how many characters fit in the panel's inner width
    // (panel width minus 22px padding on each side) so we can truncate
    // value text to keep every line inside the panel even at the
    // narrow end of the rightW range.
    const innerChars = Math.max(12, Math.floor((w - 44) / 13));
    const lastLabel = eventLabel(session.last_event_kind, session.last_event_category);
    const inTok = session.input_tokens ?? 0;
    const outTok = session.output_tokens;
    // Tokens are SCOPED TO THIS SESSION ONLY (vs. the Summary
    // "Tokens · 24h" card which sums across every scanned session).
    // `compactNumberShort` ("184k" vs "184.0k") keeps the single-line
    // string short enough to fit the right-panel inner width even at
    // the 1600×1000 default.
    const tokensLine = `Tokens in ${compactNumberShort(inTok)} / Tokens out ${compactNumberShort(outTok)}`;
    // CSS-grid-style row layout for the details block. Each row is
    // centered via setOrigin(0, 0.5) at a uniform pitch. The buttons
    // anchor to `actionsY = y + h - btnH - 16` (computed below), so
    // pre-compute that here and shrink `rowPitch` to fit the rows
    // between detailsY and the buttons. At 1280×800 compact sessionH
    // ~294 px, available space for 5 rows is only ~80 px → pitch
    // collapses to ~16 px. At 1600×1000 sessionH 320 px, available
    // space is ~120 px → pitch lands at the 22 px cap (comfortable
    // breathing room). This keeps the Tokens row from being clipped
    // by the "Open in Editor" / "Transcript" buttons at narrow sizes.
    type DetailRow = { text: string; size: number; color: string };
    const rows: DetailRow[] = [
      { text: `Status: ${session.status}`, size: 14, color: status },
      { text: `Last: ${truncate(lastLabel, Math.max(6, innerChars - 6))}`, size: 13, color: theme.text },
      { text: `Tool: ${truncate(session.last_tool || 'none', Math.max(6, innerChars - 6))}`, size: 13, color: theme.muted },
      { text: `Age: ${formatAge(session.stale_seconds)}`, size: 13, color: theme.muted },
      { text: tokensLine, size: 13, color: theme.muted },
    ];
    const btnH = 28;
    const actionsY = y + h - btnH - 16;
    const detailsBottom = actionsY - 10; // 10 px gap above the buttons
    const availableH = Math.max(60, detailsBottom - detailsY);
    const rowPitch = Math.max(16, Math.min(22, Math.floor(availableH / rows.length)));
    const firstRowY = detailsY + Math.floor(rowPitch / 2);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      this.addText(x + 22, firstRowY + i * rowPitch, r.text, r.size, r.color).setOrigin(0, 0.5);
    }

    const innerW = w - 44;
    const gap = 8;
    const tcalls = session.recent_tool_calls?.length ?? 0;
    // Buttons always render side-by-side — the panel has a fixed
    // height so stacking would push the second button into the
    // Activity Feed below. Instead, pick the widest label pair that
    // fits the panel's inner width. The original widths (170/160
    // minimums + `* 8` char estimate) work fine at typical widths;
    // narrower panels fall through to short labels with no minimum
    // so the buttons can actually shrink to fit.
    type Tier = { editor: string; transcript: string; editorMin: number; transcriptMin: number };
    const tiers: Tier[] = this.transcriptOpen
      ? [
          { editor: '↗ Open in Editor', transcript: 'Close transcript', editorMin: 170, transcriptMin: 160 },
          { editor: '↗ Editor', transcript: 'Close', editorMin: 0, transcriptMin: 0 },
        ]
      : [
          { editor: '↗ Open in Editor', transcript: `Transcript (${tcalls})`, editorMin: 170, transcriptMin: 160 },
          { editor: '↗ Editor', transcript: `Transcript (${tcalls})`, editorMin: 0, transcriptMin: 0 },
          { editor: '↗ Editor', transcript: 'Transcript', editorMin: 0, transcriptMin: 0 },
        ];
    const widthOf = (label: string, min: number) => Math.max(min, label.length * 8 + 24);

    let pick = tiers[tiers.length - 1];
    for (const tier of tiers) {
      const eW = session.git_root ? widthOf(tier.editor, tier.editorMin) : 0;
      const tW = tcalls > 0 ? widthOf(tier.transcript, tier.transcriptMin) : 0;
      const usedGap = eW > 0 && tW > 0 ? gap : 0;
      if (eW + tW + usedGap <= innerW) {
        pick = tier;
        break;
      }
    }

    // Buttons anchor to the BOTTOM of the panel rather than flowing
    // after the token rows. With variable picker rows (1-N sessions)
    // plus the stacked-tokens fallback, the flowing layout could push
    // the actions block past `sessionH` and bleed into the Activity
    // Feed. Anchoring at the bottom means the buttons always sit
    // inside the panel border; the details rows above shrink their
    // pitch to fit.
    const editorW = session.git_root ? widthOf(pick.editor, pick.editorMin) : 0;
    if (session.git_root) {
      this.drawSmallButton(x + 22, actionsY, editorW, btnH, pick.editor, '#61d6ff');
      this.openInEditorRect = { x: x + 22, y: actionsY, w: editorW, h: btnH };
    } else {
      this.openInEditorRect = null;
    }
    if (tcalls > 0) {
      const transcriptW = widthOf(pick.transcript, pick.transcriptMin);
      const btnX = x + 22 + editorW + (editorW > 0 ? gap : 0);
      this.drawSmallButton(btnX, actionsY, transcriptW, btnH, pick.transcript, this.transcriptOpen ? '#ffd54a' : '#a5b1d8');
      this.transcriptToggleRect = { x: btnX, y: actionsY, w: transcriptW, h: btnH };
    } else {
      this.transcriptToggleRect = null;
    }
  }

  private drawSmallButton(x: number, y: number, w: number, h: number, label: string, fg: string) {
    this.ui.fillStyle(0x1a2448, 0.95);
    this.ui.fillRoundedRect(x, y, w, h, 6);
    this.ui.lineStyle(1, cssToHex(fg), 0.7);
    this.ui.strokeRoundedRect(x, y, w, h, 6);
    // Center the label both horizontally and vertically inside the
    // button. Origin (0.5, 0.5) anchors the text's center to the
    // button's geometric center regardless of label length or button
    // size — keeps "↗ Editor" and "Transcript (14)" sitting in the
    // middle of their tier-fitted widths instead of left-aligned with
    // a hard-coded 12 px gutter.
    this.addText(x + w / 2, y + h / 2, label, 12, fg).setOrigin(0.5, 0.5);
  }

  private drawQuarterInspector(x: number, y: number, w: number, h: number) {
    const quarter = this.activeInspectedQuarter();
    if (!quarter) return;

    const stats = this.computeQuarterStats(quarter.key);
    const title = quarter.short;

    this.drawPanel(x, y, w, h, title);
    const compact = h < 130;
    const countLine = `${quarter.count} recent ${quarter.short.toLowerCase()} signals`;
    // Always render the count line in the main text color. The lighter
    // quarter colors (yellow, cyan, purple) are illegible on the white
    // light-mode card; black/text-color reads cleanly in both themes.
    if (compact) {
      this.addText(x + 24, y + 50, countLine, 13, theme.text).setOrigin(0, 0);
      this.addWrappedText(x + 24, y + 68, stats.line, w - 48, 12, theme.text);
    } else {
      this.addText(x + 24, y + 56, countLine, 13, theme.text).setOrigin(0, 0);
      // Live stats replace the static advice text: top tool, calls/hr,
      // avg latency, last activity age.
      this.addWrappedText(x + 24, y + 78, stats.line, w - 48, 12, theme.text);
      if (stats.toolList) {
        this.addWrappedText(x + 24, y + 98, stats.toolList, w - 48, 11, theme.muted);
      }
    }

    // Footer adapts so the red corner badge isn't a mystery: when a
    // session here needs review, surface what failed; otherwise show
    // routed session counts. When no sessions are routed, leave it empty.
    // Commands deliberately skips the "failed" surface — failed bash
    // calls aren't dev-actionable so they don't warrant a red footer.
    const quarterSessions = this.activity.sessions.filter(s => this.pickQuarterForSession(s).key === quarter.key);
    const isReviewable = quarter.key === 'terminal'
      ? (s: CopilotSessionSummary) => s.status === 'needs-attention'
      : errorOrReview;
    const flagged = quarterSessions.filter(isReviewable);
    const footerY = y + h - (compact ? 20 : 24);
    if (flagged.length > 0) {
      const first = flagged[0];
      const more = flagged.length > 1 ? ` (+${flagged.length - 1} more)` : '';
      const name = truncate(first.title || first.id, 28);
      const tool = first.last_tool || 'tool';
      const ago = formatAge(first.stale_seconds);
      this.addText(x + 24, footerY, `! ${name} — ${tool} failed ${ago} ago${more}`, 11, '#ff8a8a').setOrigin(0, 0);
    } else if (quarterSessions.length > 0) {
      const active = quarterSessions.filter(s => s.is_active).length;
      const sLabel = quarterSessions.length === 1 ? 'session' : 'sessions';
      this.addText(x + 24, footerY, `${quarterSessions.length} ${sLabel} routed here · ${active} active`, 11, '#7f97ef').setOrigin(0, 0);
    }
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

  private adjustTranscriptScroll(delta: number) {
    if (!this.transcriptOpen) return;
    const maxOffset = Math.max(0, this.transcriptRowCount - this.transcriptRowsVisible);
    const next = Math.max(0, Math.min(maxOffset, this.transcriptScrollOffset + delta));
    if (next === this.transcriptScrollOffset) return;
    this.transcriptScrollOffset = next;
    // Scroll updates ONLY redraw the transcript overlay (one graphics
    // layer + ~20 text rows) instead of the whole scene (~120 text
    // objects, full quarter + panel + castle redraw). The full
    // renderActivity path destroyed and recreated every Text on the
    // canvas per wheel tick, which is what made scrolling feel laggy.
    this.renderTranscriptOnly();
  }

  private renderTranscriptOnly() {
    if (!this.transcriptOpen || !this.selectedSession) return;
    for (const text of this.transcriptTextObjects) text.destroy();
    this.transcriptTextObjects = [];
    this.overlay.clear();
    this.drawTranscriptOverlay();
  }

  /// Creates a transcript-overlay text object. Tracked in a separate
  /// array from `textObjects` so wheel-scroll redraws can rebuild
  /// only these without tearing down the rest of the scene's text.
  private addTranscriptText(x: number, y: number, text: string, size: number, color: string) {
    const obj = this.add.text(x, y, text, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: `${size}px`,
      color,
      stroke: theme.mode === 'light' ? '#c6cfe6' : '#020713',
      strokeThickness: theme.mode === 'light' ? 0 : 3,
    }).setDepth(51);
    this.transcriptTextObjects.push(obj);
    return obj;
  }

  /// Drill-down overlay: shows the selected session's last 120 tool
  /// calls with timestamps + duration. Privacy-safe: no prompt text,
  /// no command output, no file paths beyond the repo root shown above.
  /// Scrollable via mouse wheel or up/down buttons in the scrollbar.
  private drawTranscriptOverlay() {
    const session = this.selectedSession!;
    const calls = (session.recent_tool_calls ?? []).slice().reverse();
    const w = Math.min(720, W * 0.7);
    const h = Math.min(520, H * 0.72);
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    // Paint into the dedicated overlay graphics layer (depth 50) so the
    // panel fully covers quarter labels/badges (text depth 20). Text we
    // add here gets depth 51 inside addTranscriptText for the same reason.
    const g = this.overlay;
    // Dim backdrop so overlay reads as modal.
    g.fillStyle(0x000000, 0.55);
    g.fillRect(0, 0, W, H);
    // Solid panel — must fully occlude buildings/labels behind it.
    g.fillStyle(theme.panelBg, 1);
    g.fillRoundedRect(x, y, w, h, 16);
    g.lineStyle(2, GOLD, 0.85);
    g.strokeRoundedRect(x, y, w, h, 16);
    this.addTranscriptText(x + 24, y + 18, `Tool transcript · ${truncate(session.title || session.id, 32)}`, 14, '#ffd54a').setOrigin(0, 0);
    this.addTranscriptText(x + 24, y + 42, `${session.repository} / ${session.branch} · ${calls.length} most recent calls`, 11, theme.muted).setOrigin(0, 0);

    const closeW = 32;
    const closeH = 24;
    const closeX = x + w - closeW - 12;
    const closeY = y + 12;
    // Inline close button — drawSmallButton would paint into this.ui
    // (depth 10), which sits below quarter labels.
    g.fillStyle(0x1a2448, 0.95);
    g.fillRoundedRect(closeX, closeY, closeW, closeH, 6);
    g.lineStyle(1, cssToHex('#ff7a7a'), 0.7);
    g.strokeRoundedRect(closeX, closeY, closeW, closeH, 6);
    this.addTranscriptText(closeX + 10, closeY + 5, '✕', 10, '#ff7a7a').setOrigin(0, 0);
    this.transcriptCloseRect = { x: closeX, y: closeY, w: closeW, h: closeH };

    if (calls.length === 0) {
      this.addTranscriptText(x + 24, y + 80, 'No tool calls recorded yet for this session.', 12, theme.muted);
      this.transcriptScrollUpRect = null;
      this.transcriptScrollDownRect = null;
      this.transcriptRowCount = 0;
      this.transcriptRowsVisible = 0;
      return;
    }
    const rowY0 = y + 76;
    const rowH = 28;
    const scrollbarW = 14;
    const scrollGutter = 8;
    const rowAreaH = h - (rowY0 - y) - 16;
    const maxRows = Math.max(1, Math.floor(rowAreaH / rowH));
    this.transcriptRowCount = calls.length;
    this.transcriptRowsVisible = Math.min(maxRows, calls.length);

    // Clamp scroll offset (calls.length may have grown/shrunk since last
    // render as live activity comes in).
    const maxOffset = Math.max(0, calls.length - maxRows);
    if (this.transcriptScrollOffset > maxOffset) {
      this.transcriptScrollOffset = maxOffset;
    }
    const offset = this.transcriptScrollOffset;
    const visible = calls.slice(offset, offset + maxRows);

    const rowLeftX = x + 16;
    const rowRightX = x + w - scrollbarW - scrollGutter - 16;
    const rowW = rowRightX - rowLeftX;
    for (let i = 0; i < visible.length; i++) {
      const call = visible[i];
      const ry = rowY0 + i * rowH;
      const color = call.success ? categoryColor(call.category) : 0xff5252;
      g.fillStyle(color, 0.14);
      g.fillRoundedRect(rowLeftX, ry - 2, rowW, rowH - 4, 6);
      g.fillStyle(color, 1);
      g.fillCircle(rowLeftX + 14, ry + 10, 4);
      this.addTranscriptText(rowLeftX + 28, ry + 2, truncate(call.tool, 28), 12, theme.text).setOrigin(0, 0);
      this.addTranscriptText(rowLeftX + 28 + 250, ry + 2, call.category, 10, theme.muted).setOrigin(0, 0);
      const dur = typeof call.duration_ms === 'number' ? formatDuration(call.duration_ms) : '·';
      this.addTranscriptText(rowRightX - 8, ry + 2, `${dur}  ${formatClock(call.timestamp)}`, 10, theme.muted).setOrigin(1, 0);
    }

    // Scrollbar — only render when there's overflow. Track + thumb +
    // up/down nudge buttons. Wheel events also scroll (see input setup).
    if (calls.length > maxRows) {
      this.drawTranscriptScrollbar(x + w, rowY0, maxRows, rowH, scrollbarW, scrollGutter, calls.length, maxOffset, offset);
    } else {
      this.transcriptScrollUpRect = null;
      this.transcriptScrollDownRect = null;
    }
  }

  /// Renders the transcript overlay's scrollbar (up arrow, track, thumb,
  /// down arrow) and updates the cached click rects used by
  /// `handlePointerDown`. Caller is responsible for the overflow check —
  /// this method assumes the scrollbar is needed.
  private drawTranscriptScrollbar(
    panelRight: number,
    rowY0: number,
    maxRows: number,
    rowH: number,
    scrollbarW: number,
    scrollGutter: number,
    rowCount: number,
    maxOffset: number,
    offset: number,
  ) {
    const g = this.overlay;
    const sbX = panelRight - scrollbarW - scrollGutter;
    const arrowH = 18;
    const sbTrackY = rowY0 + arrowH + 2;
    const sbTrackH = (rowY0 + maxRows * rowH) - sbTrackY - arrowH - 4;
    // Up arrow button
    g.fillStyle(0x1a2448, 0.95);
    g.fillRoundedRect(sbX, rowY0, scrollbarW, arrowH, 4);
    g.lineStyle(1, cssToHex('#a5b1d8'), 0.6);
    g.strokeRoundedRect(sbX, rowY0, scrollbarW, arrowH, 4);
    this.addTranscriptText(sbX + scrollbarW / 2, rowY0 + arrowH / 2 - 1, '▲', 9, theme.text).setOrigin(0.5, 0.5);
    this.transcriptScrollUpRect = { x: sbX, y: rowY0, w: scrollbarW, h: arrowH };
    // Track
    g.fillStyle(0x1a2448, 0.5);
    g.fillRoundedRect(sbX, sbTrackY, scrollbarW, sbTrackH, 4);
    // Thumb — height proportional to viewport coverage, y mapped to scroll fraction.
    const thumbH = Math.max(20, sbTrackH * (maxRows / rowCount));
    const thumbY = sbTrackY + (sbTrackH - thumbH) * (offset / Math.max(1, maxOffset));
    g.fillStyle(cssToHex('#a5b1d8'), 0.85);
    g.fillRoundedRect(sbX + 2, thumbY, scrollbarW - 4, thumbH, 3);
    // Down arrow button
    const downY = sbTrackY + sbTrackH + 2;
    g.fillStyle(0x1a2448, 0.95);
    g.fillRoundedRect(sbX, downY, scrollbarW, arrowH, 4);
    g.lineStyle(1, cssToHex('#a5b1d8'), 0.6);
    g.strokeRoundedRect(sbX, downY, scrollbarW, arrowH, 4);
    this.addTranscriptText(sbX + scrollbarW / 2, downY + arrowH / 2 - 1, '▼', 9, theme.text).setOrigin(0.5, 0.5);
    this.transcriptScrollDownRect = { x: sbX, y: downY, w: scrollbarW, h: arrowH };
  }

  private drawReplayTimeline(x: number, y: number, w: number, h: number) {
    const shadowColor = theme.mode === 'light' ? 0x9aa6c3 : 0x020713;
    const shadowAlpha = theme.mode === 'light' ? 0.22 : 0.52;
    this.ui.fillStyle(shadowColor, shadowAlpha);
    this.ui.fillRoundedRect(x + 4, y + 5, w, h, 12);
    this.ui.fillStyle(theme.panelBg, theme.panelBgAlpha);
    this.ui.fillRoundedRect(x, y, w, h, 12);
    this.ui.lineStyle(2, theme.panelStroke, theme.panelStrokeAlpha);
    this.ui.strokeRoundedRect(x, y, w, h, 12);

    const btnSize = 32;
    const btnY = y + (h - btnSize) / 2;
    const playX = x + 14;
    // 84 px is wide enough for "GO LIVE" at fontSize 10 (~70 px) with
    // ~7 px padding on each side. Bumped from 70 so the bigger LIVE
    // text + adaptive sizing both have breathing room.
    const liveBtnW = 84;
    const liveX = x + w - liveBtnW - 14;

    this.drawReplayButton(playX, btnY, btnSize, btnSize, this.replayPaused ? '▶' : '⏸', !this.replayPaused);
    this.replayPlayButtonRect = { x: playX, y: btnY, w: btnSize, h: btnSize };

    const atLive = this.isAtLive();
    this.drawReplayButton(liveX, btnY, liveBtnW, btnSize, atLive ? 'LIVE' : 'GO LIVE', atLive);
    this.replayLiveButtonRect = { x: liveX, y: btnY, w: liveBtnW, h: btnSize };

    const trackX = playX + btnSize + 14;
    const trackW = liveX - trackX - 14;
    const trackH = 10;
    const trackY = y + (h - trackH) / 2;
    this.replayTrackRect = { x: trackX, y: trackY - 6, w: trackW, h: trackH + 12 };

    const trackBase = theme.mode === 'light' ? 0xd2dae9 : 0x1a2448;
    this.ui.fillStyle(trackBase, 0.95);
    this.ui.fillRoundedRect(trackX, trackY, trackW, trackH, 4);

    const total = this.eventLog.length;
    const cursor = this.replayCursor;
    if (total > 0) {
      const tickColor = theme.mode === 'light' ? 0x8a98ba : 0x4566c7;
      const tickAlpha = 0.5;
      const tickEvery = Math.max(1, Math.floor(total / Math.min(total, 80)));
      for (let i = 0; i < total; i += tickEvery) {
        const tx = trackX + (i / total) * trackW;
        this.ui.fillStyle(tickColor, tickAlpha);
        this.ui.fillRect(snap(tx), snap(trackY + 2), 1, trackH - 4);
      }

      const fillColor = atLive
        ? (theme.mode === 'light' ? 0x1f7a3a : 0x60ff9a)
        : (theme.mode === 'light' ? 0xb88600 : 0xffd54a);
      const fillW = (cursor / total) * trackW;
      this.ui.fillStyle(fillColor, 0.85);
      this.ui.fillRoundedRect(trackX, trackY, Math.max(2, fillW), trackH, 4);

      const knobX = trackX + fillW;
      const knobH = trackH + 14;
      const knobY = trackY - 7;
      this.ui.fillStyle(theme.mode === 'light' ? 0x1a2240 : 0x020713, 0.9);
      this.ui.fillRect(snap(knobX - 4), snap(knobY), 8, knobH);
      this.ui.fillStyle(fillColor, 1);
      this.ui.fillRect(snap(knobX - 3), snap(knobY + 1), 6, knobH - 2);
    } else {
      this.addText(trackX + trackW / 2, trackY + trackH / 2, 'No events yet', 9, theme.muted).setOrigin(0.5);
    }

    const status = total === 0
      ? 'waiting for events'
      : atLive
        ? `${cursor} / ${total} · live`
        : this.replayPaused
          ? `${cursor} / ${total} · paused`
          : `${cursor} / ${total} · replaying`;
    const liveColor = theme.mode === 'light' ? '#1f7a3a' : '#60ff9a';
    const goldColor = theme.mode === 'light' ? '#8a5d00' : '#ffd54a';
    this.addText(trackX, y + h - 14, status, 9, atLive ? liveColor : goldColor).setOrigin(0, 0);

    this.registerReplayInteractions();
  }

  private drawReplayButton(x: number, y: number, w: number, h: number, label: string, accent: boolean) {
    const accentBg = theme.mode === 'light' ? 0xfff2cd : 0x25346c;
    const idleBg = theme.mode === 'light' ? 0xeef2fb : 0x101a3a;
    const accentStroke = theme.mode === 'light' ? 0xb88600 : 0xffd54a;
    const idleStroke = theme.mode === 'light' ? 0xc6cfe6 : 0x4566c7;
    this.ui.fillStyle(accent ? accentBg : idleBg, 0.95);
    this.ui.fillRoundedRect(x, y, w, h, 8);
    this.ui.lineStyle(2, accent ? accentStroke : idleStroke, 0.8);
    this.ui.strokeRoundedRect(x, y, w, h, 8);
    // Adaptive sizing: single glyphs (play/pause) at 14, short text
    // labels (LIVE) at 12, longer labels (GO LIVE) at 10. setOrigin
    // (0.5, 0.5) anchors the text by its visual center so the label
    // is truly centered in the button regardless of font metrics —
    // the previous `y + h/2 - fontSize/2` formula consistently sat
    // ~1-2 px high on Press Start 2P because the font's design line
    // height is wider than its glyph extent.
    const fontSize = label.length > 4 ? 10 : label.length > 2 ? 12 : 14;
    const accentText = theme.mode === 'light' ? theme.text : '#ffd54a';
    const idleText = theme.text;
    this.addText(x + w / 2, y + h / 2, label, fontSize, accent ? accentText : idleText).setOrigin(0.5, 0.5);
  }

  private registerReplayInteractions() {
    // No-op: replay button/track clicks are routed by the scene-level
    // pointerdown listener registered in create(). The button/track rects
    // are populated by drawReplayTimeline().
  }

  private drawPanel(x: number, y: number, w: number, h: number, title: string) {
    // Dark theme keeps a subtle drop shadow for depth; light theme drops
    // it entirely — soft grey shadows on white panels read as cheap UI
    // chrome rather than depth.
    if (theme.mode !== 'light') {
      this.ui.fillStyle(0x020713, 0.52);
      this.ui.fillRoundedRect(x + 6, y + 7, w, h, 16);
    }
    if (typeof this.ui.fillGradientStyle === 'function') {
      this.ui.fillGradientStyle(theme.panelGradientTop, theme.panelGradientTop, theme.panelBg, theme.panelBg, theme.panelBgAlpha, theme.panelBgAlpha, theme.panelBgAlpha - 0.04, theme.panelBgAlpha - 0.04);
    } else {
      this.ui.fillStyle(theme.panelBg, theme.panelBgAlpha);
    }
    this.ui.fillRoundedRect(x, y, w, h, 16);
    this.ui.lineStyle(2, theme.panelStroke, theme.panelStrokeAlpha);
    this.ui.strokeRoundedRect(x, y, w, h, 16);
    if (theme.mode === 'light') {
      // Soft moat-blue header — mirrors the castle's moat color
      // (0x2960c0) at low alpha so panel chrome reads as part of the
      // same mission palette as the central scene focus.
      this.ui.fillStyle(0x2960c0, 0.18);
      this.ui.fillRoundedRect(x + 10, y + 10, w - 20, 34, 10);
      this.ui.lineStyle(1, 0x2960c0, 0.55);
      this.ui.strokeRoundedRect(x + 10, y + 10, w - 20, 34, 10);
    } else if (typeof this.ui.fillGradientStyle === 'function') {
      this.ui.fillGradientStyle(0x25346c, 0x25346c, 0x1a2448, 0x1a2448, 0.95, 0.95, 0.92, 0.92);
      this.ui.fillRoundedRect(x + 10, y + 10, w - 20, 34, 10);
    } else {
      this.ui.fillStyle(0x1a2448, 0.92);
      this.ui.fillRoundedRect(x + 10, y + 10, w - 20, 34, 10);
    }
    const titleColor = theme.mode === 'light' ? theme.text : '#ffd54a';
    // Title baseline: center the text vertically inside the header
    // rect (y+10 to y+44, mid = y+27) via setOrigin(0, 0.5). The old
    // y+19 + setOrigin(0,0) put the text top at y+19, leaving the
    // visual center 4–5 px high.
    this.addText(x + 24, y + 27, title, 14, titleColor).setOrigin(0, 0.5);
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

  private addWrappedText(x: number, y: number, text: string, width: number, size: number, color: string) {
    const obj = this.add.text(x, y, text, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: `${size}px`,
      color,
      lineSpacing: 8,
      wordWrap: { width, useAdvancedWrap: true },
      stroke: theme.mode === 'light' ? '#c6cfe6' : '#020713',
      strokeThickness: theme.mode === 'light' ? 0 : 3,
    }).setDepth(20);
    this.textObjects.push(obj);
    return obj;
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
          this.playChime('turn-end');
          this.maybeNotify(`Copilot finished — ${event.session_id}`, 'Open Mission Control to review the results.');
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
        new Notification(title, { body, tag: tag ?? 'mission-control', silent: false });
      } catch { /* ignore */ }
    };
    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => { if (p === 'granted') fire(); }).catch(() => { /* ignore */ });
    }
  }

  /// Synthesize a short bell tone (turn-end) or sharper triple-pulse
  /// (attention) via the Web Audio API. Cached AudioContext is reused
  /// across sessions to keep the latency low. Silenced for the
  /// Playwright fixture so test runs stay quiet, respects the global
  /// HUD mute toggle stored in localStorage by hud.js, and self-limits
  /// to a single chime per app launch — recurring bells get annoying
  /// for a passive monitor that's left open all day.
  private playChime(variant: 'turn-end' | 'attention') {
    if (this.activity.source === 'playwright-fixture') return;
    if (isHudMuted()) return;
    if (this.chimePlayedThisSession) return;
    this.chimePlayedThisSession = true;
    try {
      const Ctor: any = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) return;
      if (!this.audioCtx) this.audioCtx = new Ctor();
      const ctx = this.audioCtx!;
      const now = ctx.currentTime;
      const tones: { freq: number; start: number; dur: number }[] = variant === 'attention'
        ? [
            { freq: 1320, start: 0, dur: 0.12 },
            { freq: 1320, start: 0.16, dur: 0.12 },
            { freq: 1760, start: 0.32, dur: 0.18 },
          ]
        : [
            { freq: 880, start: 0, dur: 0.18 },
            { freq: 1320, start: 0.06, dur: 0.22 },
          ];
      // 25% quieter than the original 0.18 peak — the chimes were a
      // bit hot for a passive monitoring panel.
      const peakGain = 0.135;
      for (const tone of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = tone.freq;
        const start = now + tone.start;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peakGain, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, start + tone.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + tone.dur + 0.05);
      }
    } catch { /* ignore */ }
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

  private hitRect(px: number, py: number, r: { x: number; y: number; w: number; h: number } | null) {
    if (!r) return false;
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  private handleScenePointerDown(pointer: any) {
    const px = pointer.x;
    const py = pointer.y;
    // Modal first: when transcript is open, only its controls fire.
    if (this.transcriptOpen) {
      if (this.hitRect(px, py, this.transcriptCloseRect)) {
        this.transcriptOpen = false;
        savePref('transcriptOpen', false);
        this.renderActivity();
      }
      return;
    }
    for (const row of this.sessionPickerRows) {
      if (this.hitRect(px, py, row)) {
        this.selectSessionById(row.id);
        return;
      }
    }
    if (this.hitRect(px, py, this.replayPlayButtonRect)) {
      this.toggleReplayPause();
      return;
    }
    if (this.hitRect(px, py, this.replayLiveButtonRect)) {
      this.jumpReplayToLive();
      return;
    }
    if (this.replayTrackRect && this.eventLog.length > 0 && this.hitRect(px, py, this.replayTrackRect)) {
      const r = this.replayTrackRect;
      const ratio = Math.max(0, Math.min(1, (px - r.x) / r.w));
      this.seekReplay(Math.round(ratio * this.eventLog.length));
      return;
    }
    if (this.hitRect(px, py, this.openInEditorRect)) {
      this.openSelectedSessionInEditor();
      return;
    }
    if (this.hitRect(px, py, this.transcriptToggleRect)) {
      this.transcriptOpen = !this.transcriptOpen;
      this.transcriptScrollOffset = 0;
      savePref('transcriptOpen', this.transcriptOpen);
      this.renderActivity();
      return;
    }
    if (this.transcriptOpen) {
      if (this.hitRect(px, py, this.transcriptScrollUpRect)) {
        this.adjustTranscriptScroll(-3);
        return;
      }
      if (this.hitRect(px, py, this.transcriptScrollDownRect)) {
        this.adjustTranscriptScroll(3);
        return;
      }
    }
    // Clicking a quarter is intentionally a no-op now: sticky last-hover
    // already keeps the inspector showing whatever the user pointed at,
    // so the previous "click to pin / click to unpin" model was redundant
    // and prone to surprise jumps when the panel snapped back to a stale
    // pinned quarter.
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

  private getQuarterSessionStats(key: MissionCategory) {
    const sessions = this.activity.sessions.filter(session => this.pickQuarterForSession(session).key === key);
    // For the Commands quarter we deliberately don't count
    // error_count toward "needs review" — failed bash commands are
    // typically LLM noise that the dev can't fix, so they shouldn't
    // turn the Commands badge red. Other quarters still escalate on
    // any error.
    const isReviewable = key === 'terminal'
      ? (s: CopilotSessionSummary) => s.status === 'needs-attention'
      : errorOrReview;
    return {
      total: sessions.length,
      active: sessions.filter(session => session.is_active).length,
      review: sessions.filter(isReviewable).length,
    };
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
    for (const text of this.transcriptTextObjects) text.destroy();
    this.transcriptTextObjects = [];
    this.sessionPickerRows = [];
    this.replayPlayButtonRect = null;
    this.replayLiveButtonRect = null;
    this.replayTrackRect = null;
    this.openInEditorRect = null;
    this.transcriptToggleRect = null;
    this.transcriptCloseRect = null;
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
    sessions: activity.sessions ?? [],
    tools: activity.tools ?? [],
    recent_events: activity.recent_events ?? [],
    alerts: activity.alerts ?? [],
  };
}

function statusColor(status: string) {
  if (status === 'needs-attention') return 0xff5252;
  if (status === 'working') return 0x60ff9a;
  if (status === 'thinking') return 0x61d6ff;
  if (status === 'waiting') return 0xffd54a;
  return 0x8c9ac8;
}

// Theme-aware text color for status strings. Bright greens/cyans/yellows
// from `statusColor()` are great as 0.28-alpha row tints in both themes
// but become near-invisible as text on a white panel — so swap them for
// darker AA-readable tones when the light theme is active.
function statusTextColor(status: string) {
  if (theme.mode === 'light') {
    if (status === 'needs-attention') return '#a01818';
    if (status === 'working') return '#1a7a3a';
    if (status === 'thinking') return '#0a5a96';
    if (status === 'waiting') return '#8a5d00';
    return '#5b6a8f';
  }
  if (status === 'needs-attention') return '#ff7777';
  return colorToCss(statusColor(status));
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

function eventLabel(kind?: string, category?: string) {
  if (!kind && !category) return 'none';
  if (kind === 'tool.execution_start') return `${category ?? 'tool'} started`;
  if (kind === 'tool.execution_complete') return category === 'alert' ? 'tool failed' : 'tool completed';
  if (kind === 'assistant.turn_start') return 'thinking started';
  if (kind === 'assistant.turn_end') return 'waiting';
  if (kind === 'user.message') return 'prompt received';
  if (kind === 'session.start') return 'session opened';
  return category && category !== 'activity' ? category : kind ?? category ?? 'activity';
}

function feedLabel(event: CopilotEventSummary) {
  if (event.kind === 'tool.execution_start') return `${event.tool} -> ${event.category}`;
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
  transcriptOpen?: boolean;
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

function formatClock(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch { return ''; }
}

/// Convert a CSS hex string ("#61d6ff") to the integer color form
/// Phaser expects (0x61d6ff). Falls back to 0xffffff on malformed
/// input so a typo can never crash the render.
function cssToHex(css: string): number {
  const s = css.trim().replace(/^#/, '');
  if (s.length !== 6) return 0xffffff;
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

/// Mirror the mute flag that hud.js stores in localStorage. Mission Control
/// chimes use a separate Web Audio context (not Phaser's master mixer),
/// so the HUD's mute button doesn't reach them directly — this helper
/// gives them a single source of truth to consult.
function isHudMuted(): boolean {
  try {
    return window.localStorage?.getItem('cmc_muted') === '1';
  } catch {
    return false;
  }
}
