declare const Phaser: any;

import { W, H } from './viewport.js';
import { buildDashboardView as buildDashboardViewModel, buildQuarterView as buildQuarterViewModel } from './dashboardView.js';
import { computeMissionLayout, sceneScale as computeSceneScale, sectorTextMetrics } from './missionLayout.js';
import type { MissionLayout } from './missionLayout.js';
import { buildOpsSummary, createOpsSummary, errorOrReview } from './opsSignals.js';
import type { OpsSummary } from './opsSignals.js';
import { advanceReplayCursor, createReplayViewState, ingestReplayEvents, isReplayAtLive, replayEventKey, seekReplayCursor } from './replayState.js';
import { findSessionIndexById, pickSelectedSession as resolveSelectedSession, sessionPickerOptions } from './sessionSelection.js';
import type {
  CopilotActivity,
  CopilotEventSummary,
  CopilotSessionSummary,
  CopilotToolMetric,
  MissionCategory,
  SessionToolCall,
} from './missionTypes.js';

interface ActivityTokenBaseline {
  input_tokens: number;
  output_tokens: number;
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

interface EventPulse {
  id: string;
  quarterKey: MissionCategory;
  color: number;
  edgeColor: number;
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
/// — the "rune lights up" sigil. Rendered with pooled/tinted Images
/// instead of per-frame Graphics commands so overlapping arrivals can
/// still brighten additively without rebuilding WebGL geometry.
/// Auto-removed once `age >= lifetime`.
interface ArrivalEffect {
  x: number;
  y: number;
  color: number;
  age: number;
  lifetime: number;
}

declare global {
  interface Window {
    __missionControlFixture?: CopilotActivity;
    __missionControlAutoFixture?: boolean;
    __cmcOnAgentActivityChanged?: () => void;
    __cmcSetTheme?: (mode: 'dark' | 'light') => void;
    __cmcSetAppTheme?: (theme: AppTheme) => void;
    __cmcUpdateModel?: (model: string) => void;
    __cmcSetPanelsHidden?: (hidden: boolean) => void;
    __cmcRenderDashboard?: (view: unknown) => void;
    __cmcRenderLiveDashboard?: (view: unknown) => void;
    __cmcRenderQuarter?: (quarter: unknown) => void;
    __cmcResetActivityStats?: () => void;
    __cmcSelectSession?: (id: string) => void;
    __cmcOpenSelectedSessionInEditor?: () => void;
    __cmcToggleReplayPause?: () => void;
    __cmcJumpReplayToLive?: () => void;
    __cmcSeekReplayRatio?: (ratio: number) => void;
  }
}

const SPACE_ATLAS_KEY = 'mc';
const SPACE_ATLAS_ROOT = '../assets/space';
const MEDIEVAL_ATLAS_KEY = 'medieval';
const MEDIEVAL_ATLAS_ROOT = '../assets/medieval';

type ThemeMode = 'dark' | 'light';
type AppTheme = 'space' | 'medieval';
type SectorTextureMap = Record<'forge' | 'library' | 'terminal' | 'signal' | 'hooks' | 'delegates' | 'skills' | 'court' | 'mcp', string>;

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
  backdropFill: 0xdfe7f2,
  panelBg: 0xffffff,
  text: '#172033',
  muted: '#52627a',
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

function normalizeAppTheme(value: string | null | undefined): AppTheme {
  return value === 'medieval' ? 'medieval' : 'space';
}

function loadInitialAppTheme(): AppTheme {
  try {
    return normalizeAppTheme(window.localStorage?.getItem('cmc_app_theme'));
  } catch {
    return 'space';
  }
}

setActiveTheme(loadInitialThemeMode());

interface MissionArtSet {
  atlasKey: string;
  centerTexture: string;
  centerYOffset: number;
  centerMaxW: number;
  centerMaxH: number;
  quarterTextures: SectorTextureMap;
  quarterSpriteYOffsets: Partial<Record<MissionCategory, number>>;
  quarterSpriteScale: Partial<Record<MissionCategory, number>>;
}

const SPACE_ART_SET: MissionArtSet = {
  atlasKey: SPACE_ATLAS_KEY,
  centerTexture: 'outpost_domed_island',
  centerYOffset: -16,
  centerMaxW: 220,
  centerMaxH: 190,
  quarterTextures: {
    forge: 'dome_glass_blue',
    library: 'outpost_disc',
    terminal: 'console_wide_teal',
    signal: 'telescope_blue',
    hooks: 'screen_radar_blue',
    delegates: 'ship_fighter_blue',
    skills: 'satellite_dish_stand',
    court: 'console_sphere',
    mcp: 'satellite_8panel',
  },
  quarterSpriteYOffsets: {
    forge: -8,
    library: -8,
  },
  quarterSpriteScale: {
    hooks: 0.82,
  },
};

const MEDIEVAL_ART_SET: MissionArtSet = {
  atlasKey: MEDIEVAL_ATLAS_KEY,
  centerTexture: 'large_castle_3',
  centerYOffset: -5,
  centerMaxW: 220,
  centerMaxH: 212,
  quarterTextures: {
    forge: 'timber_house_large',
    library: 'spellbook',
    terminal: 'blue_mage',
    signal: 'mountain_portal',
    hooks: 'dagger_blue',
    delegates: 'dark_knight',
    skills: 'potion_purple_round',
    court: 'magic_shield',
    mcp: 'forest_portal',
  },
  quarterSpriteYOffsets: {
    signal: -6,
    delegates: -4,
    skills: -6,
  },
  quarterSpriteScale: {
    terminal: 1.05,
    signal: 0.9,
    hooks: 0.88,
    delegates: 1.05,
    skills: 0.84,
    mcp: 0.9,
  },
};

const ART_SETS: Record<AppTheme, MissionArtSet> = {
  space: SPACE_ART_SET,
  medieval: MEDIEVAL_ART_SET,
};

const MISSION_SECTOR_COUNT = 9;
const CENTER_RING_DOWN_NUDGE_PX = 12;
const FOCUS_RING_UP_LIFT_PX = 16;

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
  hooks: 0x61d6ff,
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

/// Vertical offset (px at 1x scale) applied only when the sector count
/// is even and produces true side cardinals. Odd-count rings stay on the
/// ellipse so the visual flow remains evenly centered.
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
/// mystical. Tuned down from 6 for fps — every extra sample is another
/// pooled Image quad per pulse per frame.
const PULSE_TRAIL_SAMPLES = 4;
const PULSE_TRAIL_SPACING_PROGRESS = 0.055;

/// Arrival sigil — the expanding ring that blooms at a building when a
/// pulse lands. Lifetime is short so concurrent arrivals don't pile up
/// into a blinding flash; max radius scales with the scene so it reads
/// the same at every viewport size.
const ARRIVAL_LIFETIME_MS = 520;
const ARRIVAL_MAX_RADIUS_PX = 44;
const LIVE_DASHBOARD_PUBLISH_INTERVAL_MS = 250;
const PUSH_REFRESH_MIN_INTERVAL_MS = 500;
const ACTIVE_ANIMATION_REFRESH_DELAY_MS = 250;
const LIVE_RENDER_QUIET_MS = 1200;
const PULSE_TEXTURE_KEY = 'cmc-pulse-quad';
const PULSE_EDGE_TEXTURE_KEY = 'cmc-pulse-edge-quad';
const ARRIVAL_FILL_TEXTURE_KEY = 'cmc-arrival-fill';
const ARRIVAL_RING_TEXTURE_KEY = 'cmc-arrival-ring';
const PULSE_TEXTURE_SIZE = 16;
const ARRIVAL_TEXTURE_SIZE = 96;
const INITIAL_PULSE_VISUAL_POOL_SIZE = 96;
const INITIAL_ARRIVAL_VISUAL_POOL_SIZE = 48;

export class MissionControlScene extends Phaser.Scene {
  /// Full-window dark fill that sits behind the mission map. Drawn
  /// once in `create()` and resized inline if the user grows the
  /// window (the renderer uses Graphics primitives that don't
  /// auto-respond to scale.resize, so we keep a handle to redraw).
  private backdrop: any = null;
  private map!: any;
  private moatPulseRings: any[] = [];
  private pulseVisualPool: any[] = [];
  private pulseEdgeVisualPool: any[] = [];
  private arrivalFillVisualPool: any[] = [];
  private arrivalRingVisualPool: any[] = [];
  private activePulseVisualCount = 0;
  private activePulseEdgeVisualCount = 0;
  private activeArrivalVisualCount = 0;
  /// Cached castle geometry so update() can move the animated moat
  /// pulse Images every frame without recomputing layout. Populated by
  /// drawCastle() each renderActivity() pass; null until first draw.
  private moatGeometry: { x: number; y: number; radius: number; active: boolean } | null = null;
  private textObjects: any[] = [];
  private quarterCountTextObjects = new Map<string, any>();
  private appTheme: AppTheme = loadInitialAppTheme();
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
  /// of rebuilding immediately. The per-frame `update()` loop then
  /// flushes once pulses settle. During sustained bursts, the DOM
  /// dashboard gets lightweight updates while Phaser text/sprites stay
  /// untouched so pulse animation keeps a stable frame budget.
  private renderPending = false;
  private lastFullRenderAt = 0;
  private lastLiveDashboardPublishAt = 0;
  private pushRefreshEvent: any = null;
  private pendingPushRefresh = false;
  private lastPushRefreshAt = 0;
  private liveRenderQuietUntil = 0;
  private rawActivity: CopilotActivity = createEmptyActivity();
  private activityResetAtMs: number | null = null;
  private activityResetTokenBaselines: Record<string, ActivityTokenBaseline> = {};
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
    // Phaser auto-detects the JSONArray atlas format used by both theme sheets.
    this.load.atlas(
      SPACE_ATLAS_KEY,
      `${SPACE_ATLAS_ROOT}/atlas.png`,
      `${SPACE_ATLAS_ROOT}/atlas.json`,
    );
    this.load.atlas(
      MEDIEVAL_ATLAS_KEY,
      `${MEDIEVAL_ATLAS_ROOT}/spritesheet.png`,
      `${MEDIEVAL_ATLAS_ROOT}/spritesheet.json`,
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
    this.textures.get(SPACE_ATLAS_KEY)?.setFilter?.(Phaser.Textures.FilterMode.LINEAR);
    this.textures.get(MEDIEVAL_ATLAS_KEY)?.setFilter?.(Phaser.Textures.FilterMode.LINEAR);
    this.ensurePulseTextures();
    this.createPulseVisualPools();
    this.moatPulseRings = [
      this.createPooledImage(ARRIVAL_RING_TEXTURE_KEY).setDepth(2),
      this.createPooledImage(ARRIVAL_RING_TEXTURE_KEY).setDepth(2),
    ];

    // Restore last-session prefs so context survives a window restart.
    // The migration in loadMissionPrefs() folds older `pinnedDistrictKey`
    // and `inspectedDistrictKey` storage entries into the new key.
    const prefs = loadMissionPrefs();
    this.inspectedQuarterKey = prefs.inspectedQuarterKey ?? null;
    this.activityResetAtMs = validResetAtMs(prefs.activityResetAtMs);
    this.activityResetTokenBaselines = prefs.activityResetTokenBaselines ?? {};
    if (prefs.replayPaused) this.replayPaused = true;
    if (typeof prefs.lastSelectedSessionId === 'string') {
      // Mark as user-selected so pickSelectedSession respects the
      // restored id instead of jumping back to the needs-attention
      // session on the first render.
      this.userSelectedSession = true;
      // Actual index resolution happens after activity loads.
    }

    this.setActivity(this.resolveFixture());
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
      this.schedulePushRefresh();
    };
    window.__cmcSetTheme = (mode: ThemeMode) => {
      if (!this.scene?.isActive?.()) return;
      setActiveTheme(mode);
      this.redrawBackdrop();
      this.renderActivity();
    };
    window.__cmcSetAppTheme = (nextTheme: AppTheme) => {
      if (!this.scene?.isActive?.()) return;
      const normalized = normalizeAppTheme(nextTheme);
      if (normalized === this.appTheme) return;
      this.appTheme = normalized;
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
      this.selectedSession = this.pickSelectedSession();
      this.quarters = this.buildQuarters();
      this.renderActivity();
    };
    window.__cmcSelectSession = (id: string) => {
      if (!this.scene?.isActive?.()) return;
      this.selectSessionById(id);
    };
    window.__cmcResetActivityStats = () => {
      if (!this.scene?.isActive?.()) return;
      this.resetActivityStats();
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

  private refreshActivityViewState(recomputeLayout = false) {
    if (recomputeLayout || !this.layout) {
      this.layout = this.computeLayout();
    }
    this.selectedSession = this.pickSelectedSession();
    this.quarters = this.buildQuarters();
    this.hoveredQuarterKey = this.hoveredQuarterIndex >= 0
      ? this.quarters[this.hoveredQuarterIndex]?.key ?? null
      : null;
    this.opsSummary = buildOpsSummary(this.activity);
    this.pushSelectedModelToNavbar();
  }

  /// Coalesces background-driven map renders. If pulses are queued or
  /// flying we update cheap derived state + live DOM panels on a small
  /// throttle, then let `flushPendingRender()` rebuild the heavier Phaser
  /// text/sprite layer only after the animation layers are idle.
  /// We check queued pulses and arrival sigils directly because
  /// `requestRender` can fire before the per-frame counters update, and
  /// late watcher pushes can arrive while only the landing bloom remains.
  private hasActiveMotion() {
    return this.eventPulses.length > 0 || this.arrivalEffects.length > 0;
  }

  private requestRender(mode: 'normal' | 'live' = 'normal') {
    const now = performance.now();
    const deferFullRender = mode === 'live' || this.hasActiveMotion();
    if (deferFullRender) {
      this.renderPending = true;
      this.refreshActivityViewState();
      this.updateQuarterCountLabels();
      if (now - this.lastLiveDashboardPublishAt >= LIVE_DASHBOARD_PUBLISH_INTERVAL_MS) {
        this.publishLiveDashboardView();
        this.lastLiveDashboardPublishAt = now;
      }
      if (mode === 'live') {
        this.liveRenderQuietUntil = Math.max(this.liveRenderQuietUntil, now + LIVE_RENDER_QUIET_MS);
      }
      return;
    }
    this.renderPending = false;
    this.liveRenderQuietUntil = 0;
    this.renderActivity();
  }

  private schedulePushRefresh() {
    if (this.pendingPushRefresh) return;
    this.pendingPushRefresh = true;
    const elapsed = performance.now() - this.lastPushRefreshAt;
    const delay = Math.max(0, PUSH_REFRESH_MIN_INTERVAL_MS - elapsed);
    const run = () => {
      this.pushRefreshEvent = null;
      if (this.loading || this.hasActiveMotion()) {
        this.pushRefreshEvent = this.time.delayedCall(ACTIVE_ANIMATION_REFRESH_DELAY_MS, run);
        return;
      }
      this.pendingPushRefresh = false;
      this.lastPushRefreshAt = performance.now();
      void this.refreshActivity(true);
    };
    this.pushRefreshEvent = this.time.delayedCall(delay, run);
  }

  private flushPendingRender() {
    if (!this.renderPending) return;
    if (this.hasActiveMotion()) return;
    if (performance.now() < this.liveRenderQuietUntil) return;
    this.renderPending = false;
    this.liveRenderQuietUntil = 0;
    this.renderActivity();
  }

  /// Animated overlay on top of the static moat ring. Only shows when
  /// the cached geometry says sessions are active; otherwise the ring
  /// Images stay hidden so the base blue water reads as "calm".
  private updateMoatPulse() {
    for (const ring of this.moatPulseRings) ring.setVisible(false).setActive(false);
    const g = this.moatGeometry;
    if (!g || !g.active) return;
    // Two phase-offset rings, each a slow sine, so the pulse looks
    // like ripples on the water rather than a hard blink. performance.now
    // drives the phase so the animation continues smoothly across
    // renderActivity() rebuilds.
    const t = performance.now() / 1000;
    const baseR = g.radius;
    const ring = (index: number, offset: number, baseAlpha: number) => {
      const visual = this.moatPulseRings[index];
      if (!visual) return;
      const phase = (Math.sin(t * 1.6 + offset) + 1) / 2;
      const alpha = baseAlpha * (0.4 + phase * 0.6);
      const radius = baseR + phase * 6;
      this.showPooledImage(visual, g.x, g.y, radius * 2, 0x60ff9a, alpha);
    };
    ring(0, 0, 0.55);
    ring(1, Math.PI, 0.32);
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
    if (this.pushRefreshEvent) {
      this.pushRefreshEvent.remove(false);
      this.pushRefreshEvent = null;
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
    if (window.__cmcSetAppTheme) {
      window.__cmcSetAppTheme = undefined;
    }
    if (window.__cmcSetPanelsHidden) {
      window.__cmcSetPanelsHidden = undefined;
    }
    window.__cmcSelectSession = undefined;
    window.__cmcOpenSelectedSessionInEditor = undefined;
    window.__cmcRenderLiveDashboard = undefined;
    window.__cmcResetActivityStats = undefined;
    window.__cmcToggleReplayPause = undefined;
    window.__cmcJumpReplayToLive = undefined;
    window.__cmcSeekReplayRatio = undefined;
    // Blank the navbar model chip so a stale model id doesn't linger
    // when the scene tears down (game switch, hot reload, etc.).
    try { window.__cmcUpdateModel?.(''); } catch { /* no-op */ }
    this.clearDynamicObjects();
    this.destroyPulseVisualPools();
    for (const ring of this.moatPulseRings) ring.destroy();
    this.moatPulseRings = [];
    this.moatGeometry = null;
    this.eventPulses = [];
    this.arrivalEffects = [];
    this.activeEventPulseCount = 0;
    this.renderPending = false;
    this.pendingPushRefresh = false;
    this.lastPushRefreshAt = 0;
    this.eventLog = [];
    this.seenEventKeys.clear();
    this.replayCursor = 0;
    this.replayPaused = false;
    this.replayPlayTimer = 0;
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

  private ensurePulseTextures() {
    if (!this.textures.exists(PULSE_TEXTURE_KEY)) {
      const g = this.add.graphics();
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, PULSE_TEXTURE_SIZE, PULSE_TEXTURE_SIZE);
      g.generateTexture(PULSE_TEXTURE_KEY, PULSE_TEXTURE_SIZE, PULSE_TEXTURE_SIZE);
      g.destroy();
    }
    if (!this.textures.exists(PULSE_EDGE_TEXTURE_KEY)) {
      const g = this.add.graphics();
      g.lineStyle(4, 0xffffff, 0.28);
      g.strokeRect(2, 2, PULSE_TEXTURE_SIZE - 4, PULSE_TEXTURE_SIZE - 4);
      g.lineStyle(2, 0xffffff, 1);
      g.strokeRect(3, 3, PULSE_TEXTURE_SIZE - 6, PULSE_TEXTURE_SIZE - 6);
      g.lineStyle(1, 0xffffff, 0.8);
      g.strokeRect(5, 5, PULSE_TEXTURE_SIZE - 10, PULSE_TEXTURE_SIZE - 10);
      g.generateTexture(PULSE_EDGE_TEXTURE_KEY, PULSE_TEXTURE_SIZE, PULSE_TEXTURE_SIZE);
      g.destroy();
    }
    if (!this.textures.exists(ARRIVAL_FILL_TEXTURE_KEY)) {
      const g = this.add.graphics();
      const c = ARRIVAL_TEXTURE_SIZE / 2;
      g.fillStyle(0xffffff, 1);
      g.fillCircle(c, c, c - 4);
      g.generateTexture(ARRIVAL_FILL_TEXTURE_KEY, ARRIVAL_TEXTURE_SIZE, ARRIVAL_TEXTURE_SIZE);
      g.destroy();
    }
    if (!this.textures.exists(ARRIVAL_RING_TEXTURE_KEY)) {
      const g = this.add.graphics();
      const c = ARRIVAL_TEXTURE_SIZE / 2;
      g.lineStyle(6, 0xffffff, 1);
      g.strokeCircle(c, c, c - 8);
      g.generateTexture(ARRIVAL_RING_TEXTURE_KEY, ARRIVAL_TEXTURE_SIZE, ARRIVAL_TEXTURE_SIZE);
      g.destroy();
    }
  }

  private createPulseVisualPools() {
    this.pulseVisualPool = this.createImagePool(PULSE_TEXTURE_KEY, INITIAL_PULSE_VISUAL_POOL_SIZE);
    this.pulseEdgeVisualPool = this.createImagePool(PULSE_EDGE_TEXTURE_KEY, INITIAL_PULSE_VISUAL_POOL_SIZE, Phaser.BlendModes.NORMAL);
    this.arrivalFillVisualPool = this.createImagePool(ARRIVAL_FILL_TEXTURE_KEY, INITIAL_ARRIVAL_VISUAL_POOL_SIZE);
    this.arrivalRingVisualPool = this.createImagePool(ARRIVAL_RING_TEXTURE_KEY, INITIAL_ARRIVAL_VISUAL_POOL_SIZE);
  }

  private createImagePool(textureKey: string, size: number, blendMode = Phaser.BlendModes.ADD) {
    return Array.from({ length: size }, () => this.createPooledImage(textureKey, blendMode));
  }

  private createPooledImage(textureKey: string, blendMode = Phaser.BlendModes.ADD) {
    return this.add.image(0, 0, textureKey)
      .setOrigin(0.5)
      .setDepth(8)
      .setBlendMode(blendMode)
      .setActive(false)
      .setVisible(false);
  }

  private destroyPulseVisualPools() {
    for (const img of this.pulseVisualPool) img.destroy();
    for (const img of this.pulseEdgeVisualPool) img.destroy();
    for (const img of this.arrivalFillVisualPool) img.destroy();
    for (const img of this.arrivalRingVisualPool) img.destroy();
    this.pulseVisualPool = [];
    this.pulseEdgeVisualPool = [];
    this.arrivalFillVisualPool = [];
    this.arrivalRingVisualPool = [];
    this.activePulseVisualCount = 0;
    this.activePulseEdgeVisualCount = 0;
    this.activeArrivalVisualCount = 0;
  }

  private hidePulseVisuals() {
    for (let i = 0; i < this.activePulseVisualCount; i++) {
      const img = this.pulseVisualPool[i];
      img.setActive(false).setVisible(false);
    }
    for (let i = 0; i < this.activePulseEdgeVisualCount; i++) {
      const img = this.pulseEdgeVisualPool[i];
      img.setActive(false).setVisible(false);
    }
    for (let i = 0; i < this.activeArrivalVisualCount; i++) {
      const fill = this.arrivalFillVisualPool[i];
      const ring = this.arrivalRingVisualPool[i];
      fill.setActive(false).setVisible(false);
      ring.setActive(false).setVisible(false);
    }
    this.activePulseVisualCount = 0;
    this.activePulseEdgeVisualCount = 0;
    this.activeArrivalVisualCount = 0;
  }

  private nextPulseVisual() {
    if (this.activePulseVisualCount >= this.pulseVisualPool.length) {
      this.pulseVisualPool.push(this.createPooledImage(PULSE_TEXTURE_KEY));
    }
    return this.pulseVisualPool[this.activePulseVisualCount++];
  }

  private nextPulseEdgeVisual() {
    if (this.activePulseEdgeVisualCount >= this.pulseEdgeVisualPool.length) {
      this.pulseEdgeVisualPool.push(this.createPooledImage(PULSE_EDGE_TEXTURE_KEY, Phaser.BlendModes.NORMAL));
    }
    return this.pulseEdgeVisualPool[this.activePulseEdgeVisualCount++];
  }

  private nextArrivalVisualPair() {
    if (this.activeArrivalVisualCount >= this.arrivalFillVisualPool.length) {
      this.arrivalFillVisualPool.push(this.createPooledImage(ARRIVAL_FILL_TEXTURE_KEY));
      this.arrivalRingVisualPool.push(this.createPooledImage(ARRIVAL_RING_TEXTURE_KEY));
    }
    const index = this.activeArrivalVisualCount++;
    return {
      fill: this.arrivalFillVisualPool[index],
      ring: this.arrivalRingVisualPool[index],
    };
  }

  private showPooledImage(img: any, x: number, y: number, size: number, color: number, alpha: number) {
    const frame = img.frame;
    const nativeSize = Math.max(
      1,
      frame?.realWidth ?? frame?.width ?? img.width ?? PULSE_TEXTURE_SIZE,
      frame?.realHeight ?? frame?.height ?? img.height ?? PULSE_TEXTURE_SIZE,
    );
    img
      .setPosition(snap(x), snap(y))
      .setScale(size / nativeSize)
      .setTint(color)
      .setAlpha(alpha)
      .setActive(true)
      .setVisible(true);
  }

  private setActivity(activity: CopilotActivity) {
    this.rawActivity = normalizeActivity(activity);
    this.activity = this.applyActivityResetBaseline(this.rawActivity);
  }

  private applyActivityResetBaseline(activity: CopilotActivity): CopilotActivity {
    const normalized = normalizeActivity(activity);
    const resetAt = this.activityResetAtMs;
    if (!resetAt) return normalized;

    const recentEvents = normalized.recent_events.filter((event) => this.isAfterReset(event.timestamp));
    const sessions = normalized.sessions.map((session) => this.applySessionResetBaseline(session));
    const recentToolCalls = sessions.flatMap((session) => session.recent_tool_calls ?? []);
    const tools = summarizeToolCalls(recentToolCalls);
    const totalInputTokens = sessions.reduce((sum, session) => sum + (session.input_tokens ?? 0), 0);
    const totalOutputTokens = sessions.reduce((sum, session) => sum + session.output_tokens, 0);
    const totalTurns = sessions.reduce((sum, session) => sum + (session.turn_count ?? 0), 0);

    return {
      ...normalized,
      sessions,
      tools,
      recent_events: recentEvents,
      total_events: recentEvents.length,
      total_tool_calls: recentToolCalls.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_turns: totalTurns,
    };
  }

  private applySessionResetBaseline(session: CopilotSessionSummary): CopilotSessionSummary {
    const baseline = this.activityResetTokenBaselines[session.id] ?? { input_tokens: 0, output_tokens: 0 };
    const recentToolCalls = (session.recent_tool_calls ?? []).filter((call) => this.isAfterReset(call.timestamp));
    const recentTurns = (session.recent_turns ?? []).filter((turn) =>
      this.isAfterReset(turn.started_at) || this.isAfterReset(turn.ended_at)
    );
    const tokenCheckpoints = (session.token_checkpoints ?? [])
      .filter((checkpoint) => this.isAfterReset(checkpoint.timestamp))
      .map((checkpoint) => ({
        ...checkpoint,
        input_tokens: Math.max(0, checkpoint.input_tokens - baseline.input_tokens),
        output_tokens: Math.max(0, checkpoint.output_tokens - baseline.output_tokens),
      }));
    const categoryCounts = categoryCountsFromToolCalls(recentToolCalls);

    return {
      ...session,
      event_count: recentToolCalls.length,
      tool_count: recentToolCalls.length,
      write_count: categoryCounts.forge,
      read_count: categoryCounts.library,
      command_count: categoryCounts.terminal,
      web_count: categoryCounts.signal,
      task_count: categoryCounts.delegates,
      delegates_count: categoryCounts.delegates,
      skills_count: categoryCounts.skills,
      court_count: categoryCounts.court,
      mcp_count: categoryCounts.mcp,
      hooks_count: categoryCounts.hooks,
      error_count: recentToolCalls.filter((call) => call.success === false).length,
      turn_count: recentTurns.length,
      input_tokens: Math.max(0, (session.input_tokens ?? 0) - baseline.input_tokens),
      output_tokens: Math.max(0, session.output_tokens - baseline.output_tokens),
      recent_tool_calls: recentToolCalls,
      recent_turns: recentTurns,
      token_checkpoints: tokenCheckpoints,
    };
  }

  private isAfterReset(timestamp?: string | null): boolean {
    if (!this.activityResetAtMs) return true;
    if (!timestamp) return false;
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) && ms > this.activityResetAtMs;
  }

  private resetActivityStats() {
    const resetAt = Date.now();
    const baselines: Record<string, ActivityTokenBaseline> = {};
    for (const session of this.rawActivity.sessions) {
      baselines[session.id] = {
        input_tokens: session.input_tokens ?? 0,
        output_tokens: session.output_tokens,
      };
    }

    this.activityResetAtMs = resetAt;
    this.activityResetTokenBaselines = baselines;
    savePref('activityResetAtMs', resetAt);
    savePref('activityResetTokenBaselines', baselines);

    this.eventLog = [];
    this.seenEventKeys.clear();
    this.workMixHistory = {};
    this.eventPulses = [];
    this.arrivalEffects = [];
    this.hidePulseVisuals();
    this.activeEventPulseCount = 0;
    this.replayCursor = 0;
    this.replayPaused = false;
    this.replayPlayTimer = 0;
    this.updateReplayState();
    this.setActivity(this.rawActivity);
    this.renderActivity();
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
        this.setActivity(fixture);
      } else {
        const ti = (window as any).__TAURI_INTERNALS__;
        if (ti?.invoke) {
          try {
            this.setActivity(await ti.invoke('get_agent_activity') as CopilotActivity);
          } catch {
            this.setActivity(createEmptyActivity());
          }
        } else {
          this.setActivity(createEmptyActivity());
        }
      }
      this.lastRefresh = performance.now();
      const appended = this.ingestActivityEvents(this.activity.recent_events);
      this.requestRender(force && this.bootstrapCompleted && appended > 0 ? 'live' : 'normal');
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

    this.refreshActivityViewState(true);

    this.drawBackground();
    this.drawQuarters();
    this.publishDashboardView();
    this.lastFullRenderAt = performance.now();
    this.lastLiveDashboardPublishAt = this.lastFullRenderAt;
  }

  private renderMapOnly() {
    for (const text of this.textObjects) text.destroy();
    this.textObjects = [];
    this.map.clear();
    this.drawBackground();
    this.drawQuarters();
  }

  private computeLayout(): MissionLayout {
    return computeMissionLayout({
      width: W,
      height: H,
      panelsHidden: this.panelsHidden,
      sectorCount: MISSION_SECTOR_COUNT,
      centerRingDownNudgePx: CENTER_RING_DOWN_NUDGE_PX,
      focusRingUpLiftPx: FOCUS_RING_UP_LIFT_PX,
    });
  }

  private buildQuarters(): Quarter[] {
    const counts = this.selectedSessionCategoryCounts();

    const layout = this.layout ?? this.computeLayout();
    const { centerX, centerY, radiusX, radiusY, topLift, s } = layout;
    const specs: Omit<Quarter, 'x' | 'y' | 'count' | 'color'>[] = [
      { key: 'forge', label: 'Forge', short: 'Edits' },
      { key: 'library', label: 'Library', short: 'Reads' },
      { key: 'terminal', label: 'Terminal Keep', short: 'Commands' },
      { key: 'signal', label: 'Signal Tower', short: 'Web/Docs' },
      { key: 'hooks', label: 'Hook Relay', short: 'Hooks' },
      { key: 'delegates', label: 'Guild Hall', short: 'Sub-Agents' },
      { key: 'skills', label: 'Tome Hall', short: 'Skills' },
      { key: 'court', label: 'Royal Court', short: 'Intent' },
      { key: 'mcp', label: 'Envoy House', short: 'MCP' },
    ];

    // Even angular spacing keeps the sector flow circular around the
    // castle. For even-count rings the sectors include true side
    // cardinals, so diagonal sectors get a small vertical nudge to avoid
    // label crowding. Odd-count rings skip the nudge so the ellipse stays
    // balanced instead of shifting most sectors off the ring.
    const diagonalShift = Math.round(DIAGONAL_QUARTER_SHIFT_PX * Math.max(s, 0.85));
    const shouldShiftDiagonals = specs.length % 2 === 0;

    return specs.map((spec, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / specs.length;
      const sinA = Math.sin(angle);
      const isDiagonal = shouldShiftDiagonals && Math.abs(sinA) > 0.1 && Math.abs(sinA) < 0.95;
      const diagY = isDiagonal ? Math.sign(sinA) * diagonalShift : 0;
      return {
        ...spec,
        color: QUARTER_COLORS[spec.key as MissionCategory] ?? 0x9aa6c8,
        x: centerX + Math.cos(angle) * radiusX,
        y: centerY + sinA * radiusY + diagY,
        count: counts.get(spec.key) ?? 0,
      };
    });
  }

  private selectedSessionCategoryCounts(): Map<string, number> {
    const session = this.selectedSession;
    return new Map<string, number>([
      ['forge', session?.write_count ?? 0],
      ['library', session?.read_count ?? 0],
      ['terminal', session?.command_count ?? 0],
      ['signal', session?.web_count ?? 0],
      ['hooks', session?.hooks_count ?? 0],
      ['delegates', session?.delegates_count ?? session?.task_count ?? 0],
      ['skills', session?.skills_count ?? 0],
      ['court', session?.court_count ?? 0],
      ['mcp', session?.mcp_count ?? 0],
    ]);
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

  private drawBackground() {
    if (theme.mode === 'light') {
      // Light mode uses a cool slate surface instead of a near-white wash
      // so the mission map reads as a designed cockpit, not an empty page.
      this.map.fillGradientStyle(0xf1f5fb, 0xf1f5fb, 0xd7e1ee, 0xdbe4ef, 1, 1, 1, 1);
      this.map.fillRect(0, 0, W, H);
      for (let i = 0; i < 22; i++) {
        const alpha = 0.04 + i * 0.0025;
        this.map.fillStyle(i % 2 === 0 ? 0xb9c6d9 : 0xcbd6e5, alpha);
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
    const { centerX, hubY, s, quarterSize, quarterR } = layout;
    const labelBlockH = Math.round(38 * Math.max(s, 0.85));
    const frameH = quarterSize + labelBlockH;
    this.drawCastle(centerX, hubY, s);

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
      const artSet = this.activeArtSet();
      const texture = artSet.quarterTextures[quarter.key as keyof SectorTextureMap] ?? artSet.centerTexture;
      // Constrain the sprite inside a square box (max W = max H = size * 0.72)
      // centered on the halo pedestal. v2 atlas frames are mostly wide/square
      // (aspect 0.9-1.5), so a 0.72 box fills the halo nicely without
      // overflowing the bracket frame — the halo now nearly fills the
      // selector width while leaving the sprite as the focal point.
      const spriteBox = size * 0.72 * (artSet.quarterSpriteScale[quarter.key] ?? 1);
      const fit = this.fitSpriteToBox(artSet.atlasKey, texture, spriteBox, spriteBox);
      const spriteY = haloCenterY + (artSet.quarterSpriteYOffsets[quarter.key] ?? 0) * pedestalUnit;
      const sprite = this.add.image(quarter.x, spriteY, artSet.atlasKey, texture)
        .setOrigin(0.5, 0.5)
        .setDepth(7)
        .setAlpha(focused ? 1 : 0.9);
      sprite.setDisplaySize(fit.w, fit.h);
      this.textObjects.push(sprite);
      const sectorText = sectorTextMetrics(quarterR);
      const labelSize = sectorText.labelSize;
      const countSize = sectorText.countSize;
      // Place the label just below the visible halo (which now scales
      // with quarterR via pedestalUnit) with a small breathing gap so
      // text never overlaps the disc.
      const labelY = quarter.y + 42 * pedestalUnit + 8 + labelSize / 2;
      const countY = labelY + labelSize / 2 + 6 + countSize / 2;
      const countColor = colorToCss(quarterTextColor(quarter.color));
      this.addText(quarter.x, labelY, quarter.short, labelSize, theme.text).setOrigin(0.5);
      const countText = this.addText(quarter.x, countY, String(quarter.count), countSize, countColor).setOrigin(0.5);
      this.quarterCountTextObjects.set(quarter.key, countText);
    }
  }

  private updateQuarterCountLabels() {
    for (const quarter of this.quarters) {
      const countText = this.quarterCountTextObjects.get(quarter.key);
      if (countText && countText.text !== String(quarter.count)) {
        countText.setText(String(quarter.count));
      }
    }
  }

  private drawPixelPanel(x: number, y: number, w: number, h: number, color: number, focused: boolean, s: number) {
    const px = snap(x);
    const py = snap(y);
    const pw = snap(w);
    const ph = snap(h);
    const border = Math.max(2, Math.round((focused ? 4 : 2) * s));
    const notch = Math.max(10, Math.round(13 * s));
    // Dark mode keeps the deep card so the sprites pop against the navy
    // backdrop. Light mode uses a frosted card with a subtle shadow so the
    // sectors feel anchored without competing with the colored halos.
    if (theme.mode === 'light') {
      this.map.fillStyle(0x9aa8bd, 0.14);
      this.map.fillRect(px + 6 * s, py + 7 * s, pw, ph);
      this.map.fillStyle(0xffffff, 0.68);
      this.map.fillRect(px + notch, py, pw - notch * 2, ph);
      this.map.fillRect(px, py + notch, pw, ph - notch * 2);
    } else {
      this.map.fillStyle(0x020713, 0.5);
      this.map.fillRect(px + 7 * s, py + 8 * s, pw, ph);
      this.map.fillStyle(theme.panelBg, 0.94);
      this.map.fillRect(px + notch, py, pw - notch * 2, ph);
      this.map.fillRect(px, py + notch, pw, ph - notch * 2);
    }
    const bracketColor = theme.mode === 'light' ? darkenColor(color, 0.72) : color;
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
    const nearestSectorClearance = layout && this.quarters.length > 0
      ? Math.min(...this.quarters.map(quarter => Math.hypot(quarter.x - x, quarter.y - y) - layout.quarterR))
      : layout
        ? Math.min(layout.radiusX, layout.radiusY) - layout.quarterR
        : Infinity;
    const moatHeadroom = layout
      ? Math.max(60, nearestSectorClearance - quarterRingGap) / 132
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
      // The pooled ring texture's stroke sits inside its frame, so the
      // display radius must be larger than the water disk to glow outside.
      radius: moatOuterR + 24 * castleScale,
      active: active > 0,
    };

    const artSet = this.activeArtSet();
    const castleFit = this.fitSpriteToBox(
      artSet.atlasKey,
      artSet.centerTexture,
      artSet.centerMaxW * castleScale,
      artSet.centerMaxH * castleScale,
    );
    const castle = this.add.image(x, y + artSet.centerYOffset * castleScale, artSet.atlasKey, artSet.centerTexture)
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

  /// Selected-session stats for the quarter inspector: top tool,
  /// selected-session call count, average duration (when we have
  /// completed entries), and a short tool list.
  private computeQuarterStats(key: string): { line: string; toolList: string | null } {
    const session = this.selectedSession;
    const callCounts = new Map<string, number>();
    for (const call of session?.recent_tool_calls ?? []) {
      if (call.category !== key) continue;
      const name = call.target || call.tool || call.category;
      callCounts.set(name, (callCounts.get(name) ?? 0) + 1);
    }
    const tools = Array.from(callCounts.entries())
      .map(([name, count]) => ({ name, count, category: key }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const topTool = tools[0];
    const calls = this.selectedSessionCategoryCounts().get(key) ?? 0;
    let durSum = 0;
    let durCount = 0;
    for (const call of session?.recent_tool_calls ?? []) {
      if (call.category === key && typeof call.duration_ms === 'number') {
        durSum += call.duration_ms;
        durCount++;
      }
    }
    const avgMs = durCount > 0 ? Math.round(durSum / durCount) : 0;

    const parts: string[] = [];
    if (topTool) parts.push(`top: ${topTool.name} (${topTool.count})`);
    if (calls > 0) parts.push(`${calls} in selected session`);
    if (avgMs > 0) parts.push(`avg ${formatDuration(avgMs)}`);
    const line = parts.length > 0 ? parts.join(' · ') : 'No activity routed here yet.';

    const toolList = tools.length > 1
      ? `Also: ${tools.slice(1).map(t => `${t.name} (${t.count})`).join(', ')}`
      : null;
    return { line, toolList };
  }

  private buildQuarterView() {
    const quarter = this.activeInspectedQuarter();
    return buildQuarterViewModel(quarter ? {
      key: quarter.key,
      short: quarter.short,
      colorCss: colorToCss(quarter.color),
      count: quarter.count,
      stats: this.computeQuarterStats(quarter.key),
    } : null);
  }

  private publishQuarterView() {
    try {
      window.__cmcRenderQuarter?.(this.buildQuarterView());
    } catch {
      /* DOM not ready yet — next full dashboard publish will catch up */
    }
  }

  private publishLiveDashboardView() {
    if (!window.__cmcRenderLiveDashboard) {
      this.publishDashboardView();
      return;
    }
    const view = this.buildDashboardView();
    if (!view) return;
    window.__cmcRenderLiveDashboard(view);
  }

  private publishDashboardView() {
    if (!window.__cmcRenderDashboard) return;
    const view = this.buildDashboardView();
    if (!view) return;
    window.__cmcRenderDashboard(view);
  }

  private buildDashboardView() {
    if (!this.layout) return null;
    const layout = this.layout;
    const sessionOptions = this.getSessionPickerOptions();
    const quarter = this.activeInspectedQuarter();
    const result = buildDashboardViewModel({
      panelsHidden: this.panelsHidden,
      layout,
      viewportWidth: W,
      activity: this.activity,
      sessionOptions,
      selectedSessionIndex: this.selectedSessionIndex,
      selectedSession: this.selectedSession,
      eventLog: this.eventLog,
      replayPaused: this.replayPaused,
      replayCursor: this.replayCursor,
      atLive: this.isAtLive(),
      quarter: quarter ? {
        key: quarter.key,
        short: quarter.short,
        colorCss: colorToCss(quarter.color),
        count: quarter.count,
        stats: this.computeQuarterStats(quarter.key),
      } : null,
      nowMs: Date.now(),
    });
    this.sessionPickerRows = result.sessionPickerRows;
    return result.view;
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

  private activeArtSet() {
    return ART_SETS[this.appTheme] ?? SPACE_ART_SET;
  }

  /// Scale a frame uniformly so it fits inside (maxW, maxH) without
  /// distortion. The theme atlases mix wide props, tall characters, and
  /// near-square devices/objects — calling
  /// setDisplaySize(w, h) with fixed numbers would squash them. Reads
  /// the native frame size from the texture cache; falls back to the
  /// box itself if the frame isn't loaded yet (shouldn't happen post-
  /// preload but keeps us safe).
  private fitSpriteToBox(atlasKey: string, frameName: string, maxW: number, maxH: number) {
    const tex = this.textures.get(atlasKey);
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
      this.hoveredQuarterKey = next >= 0 ? this.quarters[next]?.key ?? null : null;
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
      this.renderMapOnly();
      this.publishQuarterView();
    }
  }

  private ingestActivityEvents(events: CopilotEventSummary[]) {
    const nowMs = performance.now();
    const result = ingestReplayEvents({
      events,
      eventLog: this.eventLog,
      seenEventKeys: this.seenEventKeys,
      cursor: this.replayCursor,
      paused: this.replayPaused,
      maxEvents: this.replayMaxEvents,
      includeEvent: event => this.isAfterReset(event.timestamp),
    });
    this.replayCursor = result.cursor;
    if (result.appended.length === 0) return 0;

    for (const event of result.appended) {
      // Track rolling histories. The buffer self-trims during render so
      // unbounded growth is impossible. The live entry's key
      // matches the per-session snapshot's dedupe format so
      // compute24hCategoryCounts can merge the two sources without
      // double-counting overlap.
      const quarterKey = quarterKeyForEvent(event);
      if (quarterKey && (event.kind === 'tool.execution_start' || event.kind === 'hook.start')) {
        const bucket = (this.workMixHistory[quarterKey] ??= []);
        bucket.push({ key: `${event.timestamp}|${event.tool}|${quarterKey}`, perfTs: nowMs });
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

    if (result.wasAtLive && !this.replayPaused && this.bootstrapCompleted) {
      if (this.quarters.length > 0) {
        const latestPulseByQuarter = new Map<MissionCategory, CopilotEventSummary>();
        for (const event of result.appended) {
          if (event.kind !== 'tool.execution_start' && event.kind !== 'hook.start') continue;
          const quarterKey = quarterKeyForEvent(event);
          if (!quarterKey) continue;
          latestPulseByQuarter.set(quarterKey, event);
        }
        Array.from(latestPulseByQuarter.values()).forEach((event, i) => {
          this.queueEventPulse(event, 'live', i * PULSE_STAGGER_MS);
        });
      }
    }
    this.updateReplayState();
    return result.appended.length;
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
    return isReplayAtLive(this.replayCursor, this.eventLog.length);
  }

  private updateReplayState() {
    this.replayState = createReplayViewState(this.replayPaused, this.replayCursor, this.eventLog.length);
  }

  private queueEventPulse(event: CopilotEventSummary, source: 'live' | 'replay' = 'live', delay = 0) {
    // Pulses must be in lock-step with workMixHistory so the count and
    // the visible flow agree. Only start events increment the visible
    // work mix, so completion events still appear in the Activity Feed
    // without fabricating a building animation.
    if (event.kind !== 'tool.execution_start' && event.kind !== 'hook.start') return;
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
      id: `${source}:${replayEventKey(event)}:${performance.now()}`,
      quarterKey,
      color: pulseColor,
      edgeColor: event.success ? quarter.color : 0xff8a8a,
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
    this.activeEventPulseCount = this.eventPulses.length + this.arrivalEffects.length;
  }

  private updateEventPulses(delta: number) {
    this.hidePulseVisuals();
    if (this.eventPulses.length === 0 && this.arrivalEffects.length === 0) {
      this.activeEventPulseCount = 0;
      return;
    }
    const s = sceneScale();
    const light = theme.mode === 'light';
    const headSize = 8 * s;
    let activePulseWrite = 0;

    for (const pulse of this.eventPulses) {
      pulse.delay -= delta;
      if (pulse.delay > 0) {
        this.eventPulses[activePulseWrite++] = pulse;
        continue;
      }
      pulse.progress = Math.min(1, pulse.progress + delta / pulse.duration);

      // Glowing comet tail — sample the bezier path BEHIND the head.
      // Each sample is a pooled/tinted Image quad. Phaser's Graphics docs
      // call out per-frame Graphics drawing as expensive because geometry
      // is rebuilt every render; pooled Images keep this on the fast
      // texture-batch path during live bursts.
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
        const trailT = (i + 1) / PULSE_TRAIL_SAMPLES;
        const sz = headSize * (1 - trailT * 0.65);
        if (light) {
          this.showPooledImage(this.nextPulseEdgeVisual(), tx, ty, sz * 1.45, pulse.edgeColor, 0.46 * (1 - trailT));
        }
        this.showPooledImage(this.nextPulseVisual(), tx, ty, sz, pulse.color, 0.32 * (1 - trailT));
      }

      // Pulse head — soft square halo + crisp inner box. Both are
      // pooled quads, both blend additively via their once-set
      // ADD blend mode. The halo is ~2× the head size to bloom under
      // the additive blend without smearing.
      let headX: number;
      let headY: number;
      if (pulse.progress < 0.55) {
        const local = pulse.progress / 0.55;
        headX = pulse.startX + (pulse.midX - pulse.startX) * local;
        headY = pulse.startY;
      } else {
        const local = (pulse.progress - 0.55) / 0.45;
        headX = pulse.endX;
        headY = pulse.startY + (pulse.endY - pulse.startY) * local;
      }
      if (light) {
        this.showPooledImage(this.nextPulseEdgeVisual(), headX, headY, headSize * 2.15, pulse.edgeColor, 0.24);
        this.showPooledImage(this.nextPulseEdgeVisual(), headX, headY, headSize * 1.42, pulse.edgeColor, 0.86);
      }
      this.showPooledImage(this.nextPulseVisual(), headX, headY, headSize * 2, pulse.color, 0.22);
      this.showPooledImage(this.nextPulseVisual(), headX, headY, headSize, pulse.color, 0.95);

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
      if (pulse.progress < 1) this.eventPulses[activePulseWrite++] = pulse;
    }
    this.eventPulses.length = activePulseWrite;

    // Arrival sigils — expanding ring + soft inner fill that fades as
    // it grows. Eased so the bloom is fast early then settles.
    // Uses the same pooled Image path as comet heads so landing blooms
    // avoid per-frame Graphics geometry rebuilds.
    let activeArrivalWrite = 0;
    for (const eff of this.arrivalEffects) {
      eff.age += delta;
      const t = eff.age >= eff.lifetime ? 1 : eff.age / eff.lifetime;
      // ease-out cubic so the ring snaps open then slows.
      const eased = 1 - Math.pow(1 - t, 3);
      const radius = ARRIVAL_MAX_RADIUS_PX * s * eased;
      const ringAlpha = 0.75 * (1 - t);
      const fillAlpha = 0.18 * (1 - t * t);
      const pair = this.nextArrivalVisualPair();
      const scale = Math.max(0.01, (radius * 2) / ARRIVAL_TEXTURE_SIZE);
      pair.fill
        .setPosition(snap(eff.x), snap(eff.y))
        .setScale(scale)
        .setTint(eff.color)
        .setAlpha(fillAlpha)
        .setActive(true)
        .setVisible(true);
      pair.ring
        .setPosition(snap(eff.x), snap(eff.y))
        .setScale(scale)
        .setTint(eff.color)
        .setAlpha(ringAlpha)
        .setActive(true)
        .setVisible(true);
      if (eff.age < eff.lifetime) this.arrivalEffects[activeArrivalWrite++] = eff;
    }
    this.arrivalEffects.length = activeArrivalWrite;
    this.activeEventPulseCount = this.eventPulses.length + this.arrivalEffects.length;
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
    this.setActivity(applyDemoEvent(this.rawActivity, event));
    this.ingestActivityEvents([event]);
    this.renderActivity();
  }

  private advanceReplay(delta: number) {
    if (this.quarters.length === 0) return;
    const result = advanceReplayCursor({
      eventLog: this.eventLog,
      cursor: this.replayCursor,
      paused: this.replayPaused,
      playTimer: this.replayPlayTimer,
      playbackInterval: this.replayPlaybackInterval,
      delta,
    });
    this.replayCursor = result.cursor;
    this.replayPlayTimer = result.playTimer;
    for (const event of result.events) {
      this.queueEventPulse(event, 'replay');
    }
    if (result.events.length === 0) return;
    this.updateReplayState();
    this.publishDashboardView();
  }

  public seekReplay(cursor: number) {
    const clamped = seekReplayCursor(cursor, this.eventLog.length);
    if (clamped === this.replayCursor) return;
    this.replayCursor = clamped;
    this.replayPlayTimer = 0;
    this.eventPulses = this.eventPulses.filter(p => p.source === 'live' && !p.arrived);
    this.activeEventPulseCount = this.eventPulses.length + this.arrivalEffects.length;
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
    this.activeEventPulseCount = this.eventPulses.length + this.arrivalEffects.length;
    this.updateReplayState();
    this.renderActivity();
  }

  private pickSelectedSession() {
    const result = resolveSelectedSession({
      sessions: this.activity.sessions,
      selectedIndex: this.selectedSessionIndex,
      userSelectedSession: this.userSelectedSession,
      preferredSessionId: loadMissionPrefs().lastSelectedSessionId,
    });
    this.selectedSessionIndex = result.selectedIndex;
    this.userSelectedSession = result.userSelectedSession;
    return result.session;
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
    return sessionPickerOptions(this.activity.sessions);
  }

  private selectSession(index: number) {
    if (!this.activity.sessions[index]) return;
    this.selectedSessionIndex = index;
    this.userSelectedSession = true;
    savePref('lastSelectedSessionId', this.activity.sessions[index].id);
    this.renderActivity();
  }

  private selectSessionById(id: string) {
    const index = findSessionIndexById(this.activity.sessions, id);
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
    this.quarterCountTextObjects.clear();
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
      { id: 'alpha123', title: 'Build Mission Control', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'working', event_count: 128, tool_count: 55, write_count: 16, read_count: 22, command_count: 10, web_count: 3, task_count: 4, delegates_count: 4, skills_count: 0, court_count: 4, mcp_count: 0, hooks_count: 2, error_count: 0, output_tokens: 9800, last_tool: 'apply_patch', last_event_category: 'forge' },
      { id: 'beta4567', title: 'Review Tests', repository: 'copilot-mission-control', branch: 'main', updated_at: '', is_active: true, status: 'needs-attention', event_count: 96, tool_count: 42, write_count: 5, read_count: 14, command_count: 18, web_count: 0, task_count: 5, delegates_count: 3, skills_count: 2, court_count: 1, mcp_count: 0, hooks_count: 1, error_count: 2, output_tokens: 6120, last_tool: 'bash', last_event_category: 'alert' },
      { id: 'gamma890', title: 'Research UI', repository: 'docs', branch: 'main', updated_at: '', is_active: true, status: 'thinking', event_count: 74, tool_count: 28, write_count: 1, read_count: 11, command_count: 1, web_count: 13, task_count: 2, delegates_count: 2, skills_count: 0, court_count: 0, mcp_count: 0, hooks_count: 3, error_count: 0, output_tokens: 5450, last_tool: 'web_fetch', last_event_category: 'signal' },
      { id: 'delta321', title: 'Plan Refactor', repository: 'copilot-mission-control', branch: 'feature/mission', updated_at: '', is_active: false, status: 'idle', event_count: 62, tool_count: 15, write_count: 2, read_count: 8, command_count: 1, web_count: 1, task_count: 3, delegates_count: 3, skills_count: 0, court_count: 0, mcp_count: 0, hooks_count: 0, error_count: 0, output_tokens: 3010, last_tool: 'task', last_event_category: 'delegates' },
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
    { session_id: 'alpha123', kind: 'hook.start', tool: 'postToolUse', category: 'hooks', success: true },
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
      task_count: quarterKey === 'delegates' || quarterKey === 'skills' ? session.task_count + 1 : session.task_count,
      delegates_count: quarterKey === 'delegates' ? (session.delegates_count ?? session.task_count ?? 0) + 1 : (session.delegates_count ?? session.task_count ?? 0),
      skills_count: quarterKey === 'skills' ? (session.skills_count ?? 0) + 1 : (session.skills_count ?? 0),
      court_count: quarterKey === 'court' ? (session.court_count ?? 0) + 1 : (session.court_count ?? 0),
      mcp_count: quarterKey === 'mcp' ? (session.mcp_count ?? 0) + 1 : (session.mcp_count ?? 0),
      hooks_count: quarterKey === 'hooks' ? (session.hooks_count ?? 0) + 1 : (session.hooks_count ?? 0),
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
      token_checkpoints: session.token_checkpoints ?? [],
    })),
    tools: activity.tools ?? [],
    recent_events: activity.recent_events ?? [],
    alerts: activity.alerts ?? [],
  };
}

function quarterKeyForEvent(event: CopilotEventSummary): MissionCategory | null {
  const category = event.category;
  if (category === 'forge' || category === 'library' || category === 'terminal' || category === 'signal' || category === 'hooks' || category === 'delegates' || category === 'skills' || category === 'court' || category === 'mcp') {
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

function snap(value: number) {
  return Math.round(value);
}

function sceneScale() {
  return computeSceneScale(W, H);
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

function categoryCountsFromToolCalls(calls: SessionToolCall[]): Record<string, number> {
  const counts: Record<string, number> = {
    forge: 0,
    library: 0,
    terminal: 0,
    signal: 0,
    hooks: 0,
    delegates: 0,
    skills: 0,
    court: 0,
    mcp: 0,
  };
  for (const call of calls) {
    if (call.category === 'terminal' && call.success === false) continue;
    counts[call.category] = (counts[call.category] ?? 0) + 1;
  }
  return counts;
}

function summarizeToolCalls(calls: SessionToolCall[]): CopilotToolMetric[] {
  const metrics = new Map<string, CopilotToolMetric>();
  for (const call of calls) {
    const name = call.tool || 'tool';
    const key = `${call.category}|${name}`;
    const existing = metrics.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      metrics.set(key, { name, category: call.category, count: 1 });
    }
  }
  return Array.from(metrics.values()).sort((a, b) => b.count - a.count);
}

function validResetAtMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const PREFS_KEY = 'cmc_prefs';

interface MissionPrefs {
  /// Sticky last-hovered quarter. Persists across window restarts so
  /// the inspector resumes on whatever the user was last looking at.
  inspectedQuarterKey?: string | null;
  replayPaused?: boolean;
  lastSelectedSessionId?: string | null;
  activityResetAtMs?: number | null;
  activityResetTokenBaselines?: Record<string, ActivityTokenBaseline>;
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
