import { homedir } from 'node:os';
import path from 'node:path';

/** Base directory override used by every test and smoke run. */
export const HOME_ENV_VAR = 'COMPUTER_HISTORY_HOME';

export interface DaemonPaths {
  homeDir: string;
  runDir: string;
  spoolDir: string;
  logsDir: string;
  dataDir: string;
  dbPath: string;
  socketPath: string;
  logPath: string;
}

/**
 * Numeric constants pinned by contracts.md §Numeric constants.
 * Only the subset that M0 code paths exercise appears here; later milestones
 * extend this record rather than introducing new constant homes.
 */
export const CONSTANTS = {
  /** Max IPC frame payload, both directions (1 MiB). */
  maxFrameBytes: 1024 * 1024,
  /** Force a passive WAL checkpoint when the WAL file exceeds this many bytes (32 MB). */
  walCheckpointBytes: 32 * 1024 * 1024,
  /** SQLite busy timeout in ms. */
  busyTimeoutMs: 5000,
  /** raw_events retention in hours. */
  rawRetentionHours: 48,
  /** semantic_steps retention in days; workflow-miner's MINING_WINDOW_MS (30 d) is pinned to this horizon. */
  semanticRetentionDays: 30,
  /** Rejected memory candidates retention in days. */
  rejectedMemoryRetentionDays: 30,
  /** Daemon log line retention in days. */
  logRetentionDays: 7,
  /** Processor watermark lag: only events observed before now − 2s are eligible (spec §3.11). */
  watermarkLagMs: 2000,
  /** Debounce for the post-ack watermark sweep notifying the SegmenterCoordinator. */
  watermarkSweepDebounceMs: 500,
  /** Delay before retrying the watermark sweep after a failed repository fetch. */
  watermarkSweepRetryMs: 10_000,
  /** Max content chars accepted by ingest privacy invariant (c); longer is rejected. */
  maxContentChars: 2048,
  /** Upper bound of events fetched per watermark sweep. */
  watermarkSweepLimit: 1000,
  /** Retention job cadence in hours. */
  retentionIntervalHours: 6,
  /** Activity segment closes after this much idle time (spec §3.13: ≥ 5 min). */
  segmentIdleCloseMs: 300_000,
  /** Activity segment closes once its duration reaches this bound (spec §3.13: ≥ 30 min). */
  segmentMaxDurationMs: 1_800_000,
  /** Background job queue poll cadence (brief-m3 §D3 item 2: 1s poll loop). */
  queuePollIntervalMs: 1000,
  /**
   * Job lease window; expired leases are requeued by startup/periodic recovery
   * (spec §3.24). Sized at 2× the ~240s worst-case serialized handler runtime
   * (initial + one repair at promptTimeoutMs = 120s) so a live handler is never
   * requeued mid-flight.
   */
  jobLeaseMs: 600_000,
  /** Per-attempt structured-prompt timeout (brief-m3 §D3 item 4: default 120s). */
  promptTimeoutMs: 120_000,
  /** Step text handed to the summarizer is trimmed to this many chars per step. */
  summarizeStepTextChars: 500,
  /** Cap on steps fed to ONE summarize_segment LLM call (protects the retry ladder from context-length rejection); oversized segments chain follow-up jobs per window, ordinals window-local from 0 for validateSplit. */
  summarizeMaxInputSteps: 200,
  /** Chat sessions idle longer than this are disposed (brief-m4 §D4 item 5: >10 min). */
  chatIdleGcMs: 600_000,
  /** Cadence of the chat idle-GC sweep. */
  chatGcSweepIntervalMs: 60_000,
  /** Typed supervisor exit code when the DB fails integrity_check (spec §3.25). */
  dbCorruptExitCode: 46,
  /**
   * Graceful-shutdown watchdog: if teardown has not completed within this
   * window, force-exit with code 1. The test helper's SIGKILL escalation
   * nests ABOVE this budget (watchdog + 10s margin), so a hang produces a
   * logged force-exit first and the helper SIGKILL only backstops a fully
   * wedged process. Generous for a wal_checkpoint(TRUNCATE) over a 32 MB WAL.
   */
  shutdownWatchdogMs: 15_000,
} as const;

/** LLM boundary config (contracts §Pi SDK pins). Model ids resolve at runtime. */
export interface LlmConfig {
  /** Pi agent dir holding auth.json/models.json; defaults to the SDK's own (~/.pi/agent). */
  agentDir?: string;
  chatModel: string;
  backgroundModel: string;
}

export const DEFAULT_LLM_MODELS = {
  chatModel: 'openai/gpt-5.6-luna',
  backgroundModel: 'openai/gpt-5.6-luna',
} as const;

/**
 * LLM settings for this process: env overrides over pinned defaults. Absent
 * credentials are NOT an error here — jobs fail through the normal retry
 * schedule and degrade to typed errors at completion time.
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const agentDir = env['COMPUTER_HISTORY_LLM_AGENT_DIR'];
  return {
    ...(agentDir !== undefined && agentDir !== '' ? { agentDir } : {}),
    chatModel: env['COMPUTER_HISTORY_CHAT_MODEL'] || DEFAULT_LLM_MODELS.chatModel,
    backgroundModel: env['COMPUTER_HISTORY_BACKGROUND_MODEL'] || DEFAULT_LLM_MODELS.backgroundModel,
  };
}

export function daemonHome(): string {
  return process.env[HOME_ENV_VAR] || path.join(homedir(), 'Library', 'Application Support', 'ComputerHistory');
}

export function resolvePaths(homeDir = daemonHome()): DaemonPaths {
  const runDir = path.join(homeDir, 'run');
  const spoolDir = path.join(homeDir, 'spool');
  const logsDir = path.join(homeDir, 'logs');
  const dataDir = path.join(homeDir, 'data');
  return {
    homeDir,
    runDir,
    spoolDir,
    logsDir,
    dataDir,
    dbPath: path.join(dataDir, 'history.db'),
    socketPath: path.join(runDir, 'history.sock'),
    logPath: path.join(logsDir, 'daemon.jsonl'),
  };
}
