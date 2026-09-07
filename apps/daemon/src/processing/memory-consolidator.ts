import type { MemoryKind } from '@computer-history/protocol';

import type {
  MemoriesRepository,
  MemorySqlRow,
  StatusTransition,
} from '../db/memories-repository.js';

/**
 * Memory consolidation rules engine (spec §3.16–§3.17), PURE over one
 * canonical_key group: sorted rows + their evidence ledgers in → status
 * transitions out. No clock reads, no DB writes — the caller applies the
 * returned transitions transactionally (memories-repository
 * .applyStatusTransitions refuses rows carrying a manual confirmation,
 * mirroring the filter below as defense in depth).
 */

// Numeric constants pinned by contracts §Numeric constants / spec §3.16–§3.17.
export const PROMOTION_MIN_CONFIDENCE = 0.8;
export const FACT_MIN_DISTINCT_EPISODES = 2;
export const PREFERENCE_PROCEDURE_MIN_DISTINCT_EPISODES = 3;
export const PREFERENCE_PROCEDURE_MIN_DISTINCT_DAYS = 2;
/** A competing candidate supersedes an active memory at EXACTLY this count. */
export const SUPERSESSION_MIN_NEWER_EPISODES = 2;

export interface EvidenceObservation {
  episodeId: string;
  createdAtMs: number;
  confidence: number;
}
export interface ConsolidationRow extends Omit<MemorySqlRow, 'manual_confirmed_at_ms'> {
  manualConfirmedAtMs: number | null;
}

/** One canonical_key group: its rows plus each row's evidence ledger. */
export interface ConsolidationGroup {
  canonicalKey: string;
  rows: ConsolidationRow[];
  /** memory id → observations, oldest first. */
  evidenceByMemory: Map<string, EvidenceObservation[]>;
}

const UTC_DAY_LENGTH = 10; // 'YYYY-MM-DD'.length

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, UTC_DAY_LENGTH);
}

function distinctEpisodes(evidence: EvidenceObservation[]): number {
  return new Set(evidence.map((e) => e.episodeId)).size;
}

function distinctUtcDays(evidence: EvidenceObservation[]): number {
  return new Set(evidence.map((e) => utcDay(e.createdAtMs))).size;
}

/**
 * Promotion matrix (spec §3.16): fact needs ≥2 distinct episodes; preference
 * and procedure need ≥3 distinct episodes spanning ≥2 distinct UTC calendar
 * days; every kind needs top confidence ≥ 0.80. Below any threshold the row
 * stays a candidate — a single observation NEVER promotes.
 */
export function promotionQualifies(
  kind: MemoryKind,
  evidence: EvidenceObservation[],
  topConfidence: number,
): boolean {
  if (topConfidence < PROMOTION_MIN_CONFIDENCE) return false;
  switch (kind) {
    case 'fact':
      return distinctEpisodes(evidence) >= FACT_MIN_DISTINCT_EPISODES;
    case 'preference':
    case 'procedure':
      return (
        distinctEpisodes(evidence) >= PREFERENCE_PROCEDURE_MIN_DISTINCT_EPISODES &&
        distinctUtcDays(evidence) >= PREFERENCE_PROCEDURE_MIN_DISTINCT_DAYS
      );
  }
}

/**
 * Contradiction supersession (spec §3.17): when a competing candidate under
 * the same canonical_key has accumulated ≥ 2 evidence episodes NEWER than
 * everything the active row observed, the old value becomes superseded and
 * the challenger becomes active. Manual rows are immune.
 */
export function supersessionNewerCount(
  challengerEvidence: EvidenceObservation[],
  activeNewestAtMs: number,
): number {
  return new Set(
    challengerEvidence.filter((e) => e.createdAtMs > activeNewestAtMs).map((e) => e.episodeId),
  ).size;
}

/**
 * Full pass over one group. Order matters: promotions are evaluated first
 * under the §3.17 single-active gate (below), then contradiction supersession
 * runs against every non-manual active row. Transitions are deduplicated per
 * row; the last verdict for a row wins.
 *
 * Promotion gate (§3.17): a qualifying candidate whose key group holds an
 * ACTIVE row with a DIFFERENT text never plain-promotes. A manual incumbent
 * blocks entirely (manual priority beats automation). An auto incumbent is
 * superseded only when the challenger has ≥ SUPERSESSION_MIN_NEWER_EPISODES
 * evidences newer than the incumbent's newest observation — and then the pair
 * (incumbent → superseded, challenger → active) is emitted INSTEAD of a
 * second activation, so one pass can never leave two active rows behind.
 */
export function consolidateGroup(group: ConsolidationGroup): StatusTransition[] {
  const byId = new Map<string, StatusTransition>();

  const isAuto = (row: ConsolidationGroup['rows'][number]): boolean =>
    row.manualConfirmedAtMs === null;

  const norm = (text: string): string => text.trim().toLowerCase();

  /** Status after transitions already emitted this pass (input fallback). */
  const effectiveStatus = (id: string, fallback: string): string =>
    byId.get(id)?.toStatus ?? fallback;

  // 1. Promotion of candidates (§3.16) gated by §3.17 incumbency.
  for (const row of group.rows) {
    if (row.status !== 'candidate' || !isAuto(row)) continue;
    const evidence = group.evidenceByMemory.get(row.id) ?? [];
    if (
      !promotionQualifies(row.kind as MemoryKind, evidence, row.confidence)
    ) {
      continue;
    }
    const incumbents = group.rows.filter(
      (other) =>
        other.id !== row.id &&
        effectiveStatus(other.id, other.status) === 'active' &&
        norm(other.text) !== norm(row.text),
    );
    if (incumbents.length === 0) {
      // Empty key group or same-text twin only: plain promotion stands.
      byId.set(row.id, { id: row.id, toStatus: 'active' });
      continue;
    }
    if (incumbents.some((incumbent) => !isAuto(incumbent))) {
      continue; // manual priority: different-text candidates stay candidates
    }
    const supersedable = incumbents.every((incumbent) => {
      const incumbentEvidence = group.evidenceByMemory.get(incumbent.id) ?? [];
      const incumbentNewest =
        incumbentEvidence.length > 0
          ? Math.max(...incumbentEvidence.map((e) => e.createdAtMs))
          : incumbent.last_seen_at_ms;
      return (
        supersessionNewerCount(evidence, incumbentNewest) >=
        SUPERSESSION_MIN_NEWER_EPISODES
      );
    });
    if (!supersedable) continue; // stays candidate — no second active row
    for (const incumbent of incumbents) {
      byId.set(incumbent.id, { id: incumbent.id, toStatus: 'superseded' });
    }
    byId.set(row.id, { id: row.id, toStatus: 'active' });
  }

  // 2. Contradiction supersession (§3.17).
  // Snapshots reflect transitions already emitted in pass 1: an incumbent
  // demoted there never acts as an active here, and a candidate promoted
  // there never acts as a challenger.
  const statusOf = (row: ConsolidationGroup['rows'][number]): string =>
    effectiveStatus(row.id, row.status);
  const actives = group.rows.filter((r) => statusOf(r) === 'active' && isAuto(r));
  // Manual decisions win (§3.17): user-rejected rows are never challengers.
  const challengers = group.rows.filter(
    (r) =>
      (statusOf(r) === 'candidate' || statusOf(r) === 'superseded') && isAuto(r),
  );
  let challengerActivated = false;
  // Freshest-evidence timestamp per row, computed once per group: the
  // challenger loop previously re-reduced the winner's evidence array on
  // every comparison, O(k²·e) scans per active instead of O(k + e).
  const newestById = new Map(
    group.rows.map((row) => {
      const ev = group.evidenceByMemory.get(row.id) ?? [];
      return [
        row.id,
        ev.length > 0 ? Math.max(...ev.map((e) => e.createdAtMs)) : row.last_seen_at_ms,
      ] as const;
    }),
  );
  for (const active of actives) {
    const activeEvidence = group.evidenceByMemory.get(active.id) ?? [];
    const activeNewest =
      activeEvidence.length > 0
        ? Math.max(...activeEvidence.map((e) => e.createdAtMs))
        : active.last_seen_at_ms;
    const newestOf = (row: ConsolidationGroup['rows'][number]): number =>
      newestById.get(row.id) ?? row.last_seen_at_ms;
    // §3.17 single-active invariant: exactly ONE challenger wins activation
    // per pass. Among qualifiers, the freshest evidence wins — rows are loaded
    // created_at ASC, so first-match would wrongly favor the oldest claim.
    let winner: (typeof challengers)[number] | null = null;
    for (const challenger of challengers) {
      if (norm(challenger.text) === norm(active.text)) {
        continue; // same logical claim — never a contradiction
      }
      const challengerEvidence = group.evidenceByMemory.get(challenger.id) ?? [];
      if (
        supersessionNewerCount(challengerEvidence, activeNewest) <
        SUPERSESSION_MIN_NEWER_EPISODES
      ) {
        continue;
      }
      if (winner === null || newestOf(challenger) > newestOf(winner)) winner = challenger;
    }
    if (winner !== null && !challengerActivated) {
      byId.set(active.id, { id: active.id, toStatus: 'superseded' });
      byId.set(winner.id, { id: winner.id, toStatus: 'active' });
      challengerActivated = true;
    }
  }

  return [...byId.values()];
}

/**
 * Loads every touched canonical_key group from the repository, runs the pure
 * engine, applies the transitions in one transaction per key and reports the
 * keys whose rows actually changed (drives memories_changed).
 */
export function runConsolidation(
  repo: Pick<MemoriesRepository, 'listByKey' | 'listEvidence' | 'applyStatusTransitions'>,
  canonicalKeys: Iterable<string>,
  nowMs: number,
): string[] {
  const changed: string[] = [];
  for (const canonicalKey of canonicalKeys) {
    const rows = repo.listByKey(canonicalKey);
    if (rows.length === 0) continue;
    const evidenceByMemory = new Map<string, EvidenceObservation[]>();
    for (const row of rows) {
      evidenceByMemory.set(row.id, repo.listEvidence(row.id));
    }
    const transitions = consolidateGroup({
      canonicalKey,
      rows: rows.map((row) => ({
        ...row,
        manualConfirmedAtMs: row.manual_confirmed_at_ms,
      })),
      evidenceByMemory,
    });
    if (repo.applyStatusTransitions(transitions, nowMs) > 0) changed.push(canonicalKey);
  }
  return changed;
}
