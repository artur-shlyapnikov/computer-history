import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CorruptDatabaseError, enforceSidecarPerms, openDatabase, startCheckpointWatch } from './db/database.js';
import { EpisodesRepository } from './db/episodes-repository.js';
import { MemoriesRepository } from './db/memories-repository.js';
import { WorkflowsRepository } from './db/workflows-repository.js';
import { JobsRepository } from './db/jobs-repository.js';
import { SegmentsRepository } from './db/segments-repository.js';
import { EventsRepository } from './db/events-repository.js';
import { migrate } from './db/migrator.js';
import { HistoryPipeline } from './processing/history-pipeline.js';
import { PiRuntime } from './llm/pi-runtime.js';
import {
  ChatSessionManager,
  createPiChatSessionFactory,
  loadChatSystemPrompt,
} from './agent/agent-session.js';
import { createChatTools } from './agent/tools/index.js';
import { RetentionService } from './services/retention-service.js';
import { DeleteService } from './services/delete-service.js';
import { DiskGuard } from './services/disk-guard.js';
import { HistoryService } from './services/history-service.js';
import { registerSegmentsOps } from './ipc/timeline-ops.js';
import { registerDeleteOps } from './ipc/delete-ops.js';
import { registerJobOps } from './ipc/job-ops.js';
import { IpcServer } from './ipc/server.js';
import { registerRetrievalOps } from './ipc/retrieval-ops.js';
import { registerChatOps } from './ipc/chat-ops.js';
import { registerSettingsOps } from './ipc/settings-ops.js';
import { registerDiagnosticsOps } from './ipc/diagnostics-ops.js';
import { Router, OpError } from './ipc/router.js';
import { CONSTANTS, loadLlmConfig, resolvePaths, type DaemonPaths } from './config.js';
import { createLogger, type Logger } from './logging.js';
import { daemonVersion, registerStatusOp } from './ipc/status.js';

export interface DaemonRuntime {
  paths: DaemonPaths;
  logger: Logger;
  shutdown: () => Promise<void>;
  server: IpcServer;
  /** Test seam: direct dispatch without a socket client. */
  router: Router;
}

export async function buildRuntime(paths = resolvePaths()): Promise<DaemonRuntime> {
  for (const dir of [paths.homeDir, paths.runDir, paths.spoolDir, paths.logsDir, paths.dataDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Recursive mkdir only applies the mode to a newly created leaf; chmod
    // unconditionally so pre-existing (0755) installs are tightened too.
    chmodSync(dir, 0o700);
  }
  const logger = createLogger(paths.logPath);
  const removed = logger.pruneOld(CONSTANTS.logRetentionDays);
  if (removed > 0) logger.log('info', 'logging', 'pruned old log lines', { removed });

  let db;
  try {
    db = openDatabase(paths.dbPath);
  } catch (err) {
    if (err instanceof CorruptDatabaseError) {
      // Spec §3.25 UI string, verbatim: the recorder maps this state to
      // daemon_error; the daemon NEVER recreates the file over the old one.
      logger.log('error', 'db', 'History database needs recovery', {
        errorMessage: err.message,
      });
    }
    throw err;
  }
  const migration = migrate(db);
  // SEC-003: first-run migration writes create the WAL lazily after open;
  // tighten the sidecars once migrations are done.
  enforceSidecarPerms(paths.dbPath);
  const schemaVersion = migration.schemaVersion;
  logger.log('info', 'db', 'migrations applied', { appliedCount: migration.applied.length, schemaVersion });

  const startedAtMs = Date.now();
  const version = daemonVersion();
  const router = new Router(logger);

  const eventRepository = new EventsRepository(db);
  const jobsRepository = new JobsRepository(db);
  const segmentsRepository = new SegmentsRepository(db);
  const episodesRepository = new EpisodesRepository(db);
  const memoriesRepository = new MemoriesRepository(db);
  const workflowsRepository = new WorkflowsRepository(db);
  const historyService = new HistoryService(db);

  const llmConfig = loadLlmConfig();

  // Background distillation graph (raw events → segments → LLM episodes,
  // memories, workflows) behind one subsystem boundary: the job topology,
  // its serialization policy, the shared queue_update dedup sink and the
  // drain/finalize shutdown order all live in HistoryPipeline. main.ts only
  // composes daemon-level policy around it. broadcastEvent closes over
  // `server` below — like every registration here it can only fire after
  // server.listen().
  const pipeline = new HistoryPipeline({
    db,
    events: eventRepository,
    segments: segmentsRepository,
    episodes: episodesRepository,
    memories: memoriesRepository,
    workflows: workflowsRepository,
    jobs: jobsRepository,
    logger,
    llmConfig,
    broadcastEvent: (kind, payload) => server.broadcastEvent(kind, payload),
  });
  registerStatusOp(router, {
    db,
    startedAtMs,
    daemonVersion: version,
    schemaVersion,
    homeDir: paths.homeDir,
    recording: () => ({
      paused: diskGuard.isPaused(),
      ...(diskGuard.isPaused() ? { reason: 'disk_pressure' as const } : {}),
    }),
  });
  registerRetrievalOps(router, {
    history: historyService,
    memories: memoriesRepository,
    workflows: workflowsRepository,
    onMemoriesChanged: () => server.broadcastEvent('memories_changed', {}),
    onWorkflowsChanged: () => server.broadcastEvent('workflows_changed', {}),
  });

  const retention = new RetentionService({
    db,
    events: eventRepository,
    segments: segmentsRepository,
    memories: memoriesRepository,
    logger,
    logsDir: paths.logsDir,
    logPath: paths.logPath,
  });
  retention.start();

  // Disk-pressure guard (spec §3.25): statfs before each ingest batch and on
  // a 60s timer; low disk fires retention once, then pauses recording and
  // refuses events.batch until the 1.2 GiB hysteresis clears.
  const diskGuard = new DiskGuard({
    path: paths.homeDir,
    logger,
    triggerRetention: () => {
      retention.run();
    },
    onRecordingStateChanged: (paused, reason) => {
      server.broadcastEvent(
        'recording_state',
        paused ? { state: 'paused', reason } : { state: 'active' },
      );
    },
  });
  diskGuard.start();

  router.registerBatch(async (batch) => {
    const gate = await diskGuard.gateBatch();
    if (!gate.ok) throw new OpError(gate.code, gate.message);
    return pipeline.ingest(batch);
  });
  registerSegmentsOps(router, { segments: segmentsRepository, episodes: episodesRepository, jobs: jobsRepository });

  const deletes = new DeleteService({ db, workflows: workflowsRepository, logger });
  registerDeleteOps(router, {
    deletes,
    onChanged: () => {
      server.broadcastEvent('episodes_changed', {});
      server.broadcastEvent('memories_changed', {});
      server.broadcastEvent('workflows_changed', {});
    },
  });
  registerJobOps(router, {
    jobs: jobsRepository,
    onQueueUpdate: (pendingJobs) => pipeline.emitQueueUpdate(pendingJobs),
  });

  // Chat agent (spec §3.19): independent from the serialized job worker.
  // Sessions are created lazily per chat.send; missing credentials surface as
  // chat_error llm_unavailable, never a startup failure. PiRuntime.get is
  // therefore deferred into the session factory — it can stall under load and
  // must never delay daemon readiness.
  const chatTools = createChatTools({
    historyService,
    episodes: episodesRepository,
    memories: memoriesRepository,
    workflows: workflowsRepository,
  });
  const chatManager = new ChatSessionManager({
    sessionFactory: async () => {
      const piRuntime = await PiRuntime.get(llmConfig);
      const factory = createPiChatSessionFactory({
        modelRuntime: piRuntime.getSdkRuntime(),
        tools: chatTools,
        resolveChatModel: () => piRuntime.resolveChat(),
      });
      return factory();
    },
    systemPrompt: loadChatSystemPrompt(),
  });
  registerChatOps(router, {
    chat: chatManager,
    broadcastEvent: (kind, payload) => server.broadcastEvent(kind, payload),
    logger,
  });
  registerSettingsOps(router, { chatModel: llmConfig.chatModel, backgroundModel: llmConfig.backgroundModel });
  registerDiagnosticsOps(router, {
    db,
    lastErrors: () => logger.recentErrors(),
  });

  const server = new IpcServer({
    socketPath: paths.socketPath,
    router,
    logger,
    daemonVersion: version,
    databaseSchemaVersion: schemaVersion,
  });

  // Shared teardown for graceful shutdown AND boot failure: a throw in the
  // post-listen window below must not strand the bound socket file, the
  // started timers, or an open WAL. The checkpoint-watch handle does not
  // exist yet when a boot failure strikes — hence the nullable declaration.
  let stopCheckpointWatch: (() => void) | null = null;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Round-36 audit: any hung teardown step below (drain Promise.all,
    // jobWorker.stop, chatManager.dispose, WAL checkpoint, db.close) must
    // never leave a zombie daemon holding the DB and socket file — mirror
    // the test-helper SIGTERM→SIGKILL escalation and force-exit.
    const watchdog = setTimeout(() => {
      logger.log('error', 'main', 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, CONSTANTS.shutdownWatchdogMs);
    watchdog.unref();
    try {
      await server.close();
      // Processing graph teardown (ingestor timers → watermark drain →
      // poll-loop stop → final segment finalize) owns its own load-bearing
      // ordering; every step's rationale is documented on
      // HistoryPipeline.shutdown.
      await pipeline.shutdown();
      retention.stop();
      diskGuard.stop();
      // Chat sessions are in-memory only; dispose before the WAL checkpoint.
      await chatManager.dispose();
      if (stopCheckpointWatch !== null) stopCheckpointWatch();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      logger.log('info', 'main', 'graceful shutdown complete');
    } finally {
      clearTimeout(watchdog);
    }
  };

  await server.listen();

  // Background work starts only once the IPC surface is live so
  // queue_update/episodes_changed broadcasts reach connected clients
  // (spec §3.15).
  try {
    pipeline.start();
    stopCheckpointWatch = startCheckpointWatch(db, paths.dbPath, CONSTANTS.walCheckpointBytes);
  } catch (err) {
    bootFailed = true;
    await shutdown();
    throw err;
  }
  return { paths, logger, shutdown, server, router };
}

let runtime: DaemonRuntime | null = null;
let signalReceived = false;
let bootFailed = false;

function onSignal(signal: string): void {
  if (signalReceived) return;
  signalReceived = true;
  if (runtime === null) {
    // Signal during startup: nothing to finalize and no logger exists yet.
    // Round-37 audit: a signal landing mid-boot-failure-teardown must NOT
    // exit(0) — that would skip the remaining shutdown steps and mask the
    // failure exit code already recorded via process.exitCode in main()'s
    // catch. Let the in-flight shutdown finish (the watchdog bounds a hang).
    if (bootFailed) return;
    console.error(`${signal} received during startup; exiting`);
    process.exit(0);
  }
  runtime.logger.log('info', 'main', 'signal received', { signal });
  void runtime.shutdown().then(() => process.exit(0), () => process.exit(1));
}

function isBindError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

export async function main(): Promise<void> {
  // Handlers MUST be registered before buildRuntime: startup can stall inside
  // PiRuntime-dependent work under load, and a serving-but-not-yet-ready
  // daemon must still shut down gracefully instead of dying to the default
  // signal disposition (no finalize, no WAL checkpoint).
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  try {
    runtime = await buildRuntime();
  } catch (err) {
    if (isBindError(err)) {
      console.error('another daemon instance already owns the socket; exiting');
      process.exitCode = 1;
      return;
    }
    if (err instanceof CorruptDatabaseError) {
      // Typed supervisor contract (spec §3.25): exit 46 means «History
      // database needs recovery» — the file is left EXACTLY as found so a
      // human can recover it; the recorder maps this to daemon_error.
      console.error('History database needs recovery; exiting without recreating it');
      process.exitCode = CONSTANTS.dbCorruptExitCode;
      return;
    }
    // Round-38 audit: exit 1 must not depend on Node's default
    // --unhandled-rejections=throw disposition (a launcher setting warn/none
    // would turn a boot failure into exit 0) — fail explicitly like the
    // typed branches above.
    console.error('daemon boot failed:', err);
    process.exitCode = 1;
    return;
  }
  const { logger } = runtime;
  logger.log('info', 'main', 'daemon ready');
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryHref !== '' && import.meta.url === entryHref) {
  void main();
}
