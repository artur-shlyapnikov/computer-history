/**
 * Pure workflow-mining math (spec §3.20, brief-m6 §D6 item 1). No clock, no
 * DB, no I/O — every function here is deterministic and exhaustively unit
 * tested (golden table + hand-computed similarity fixture ±1e-9).
 *
 * Step signature: `${normalize(appBundleId)}.${action}.${role}.${targetClass}`
 * lowercased, with EMPTY segments dropped. Spec examples hold EXACTLY:
 *   Slack click button "Create"            ⇒ slack.click.button.create
 *   Jira text_edit textarea "Fix TANGO-123" ⇒ jira.text_edit.textarea
 * (the dynamic label reduces to nothing, so the class segment disappears).
 *
 * DOCUMENTED LIMITATION: semantic_steps stores a single human-facing `target`
 * string (label ?? identifier ?? role) and no separate role column, so miner
 * callers cannot supply targetRole for persisted steps — their signatures
 * simply omit the role segment. The pure function accepts the role whenever
 * a caller knows it (e.g. replayed wire events), keeping spec fidelity.
 */

/** Pinned weights (spec §3.20; contracts restates them for tests). */
export const SEQ_WEIGHT = 0.6;
export const APP_WEIGHT = 0.25;
export const INTENT_WEIGHT = 0.15;

/** Pinned mining thresholds (spec §3.20 / contracts §Numeric constants). */
export const OCCURRENCE_SIMILARITY_MIN = 0.74;
export const CANDIDATE_MEDIAN_MIN = 0.78;
export const APP_JACCARD_POOL_MIN = 0.5;

/** Pinned step-count window (spec §3.20 candidate lookup). */
export const MIN_STEPS = 3;
export const MAX_STEPS = 40;

const QUOTES = /^['"`‘’“”]+|['"`‘’“”]+$/g;

/**
 * App token: lowercase, last reverse-DNS/path segment, digits and separators
 * stripped ("com.apple.Safari" → "safari", bare "Slack" → "slack").
 */
export function normalizeAppBundleId(raw: string): string {
  const tail = raw.trim().replace(QUOTES, '').split(/[./\\: ]+/).pop() ?? '';
  return stripToLetters(tail).toLowerCase();
}

/**
 * Dynamic-value stripping per brief-m6: quotes removed, LAST path/whitespace
 * token taken, then UUIDs, ticket ids ([A-Z]+-[0-9]+, case-sensitive — the
 * pinned spec shape, single-letter prefixes like B-2 included) and digit runs
 * are removed; whatever survives must be a single letter word. Empty result ⇒
 * '' (segment omitted downstream).
 */
export function normalizeTargetClass(raw: string): string {
  let s = raw.trim().replace(QUOTES, '');
  if (s === '') return '';
  const tokens = s.split(/[/\\: \t]+/).filter((t) => t !== '');
  const last = tokens[tokens.length - 1];
  if (last === undefined) return '';
  s = last
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '')
    .replace(/[A-Z]+-[0-9]+/g, '')
    .replace(/\d+/g, '');
  return stripToLetters(s).toLowerCase();
}

/** Keep Unicode letters and inner separators, trim edge separators. */
function stripToLetters(s: string): string {
  return s
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

export interface FingerprintStepInput {
  appBundleId: string;
  action: string;
  /** UI control role when known (ActivityEvent.target.role); optional. */
  targetRole?: string | null;
  /** Human-facing target (label ?? identifier ?? role); may reduce to ''. */
  target?: string | null;
}

/** One step → its signature; empty segments are dropped after normalization. */
export function stepFingerprint(step: FingerprintStepInput): string {
  return [
    normalizeAppBundleId(step.appBundleId),
    step.action.trim().toLowerCase(),
    (step.targetRole ?? '').trim().toLowerCase(),
    normalizeTargetClass(step.target ?? ''),
  ]
    .filter((part) => part !== '')
    .join('.');
}

/** Normalized app set of an episode (spec §3.20 app-set Jaccard input). */
export function episodeAppSet(steps: ReadonlyArray<{ appBundleId: string }>): Set<string> {
  return new Set(steps.map((s) => normalizeAppBundleId(s.appBundleId)));
}

/**
 * Intent comparison key: lowercase, non-alphanumeric runs collapse to one
 * space. Two episodes count as intent-equal iff both normalized intents are
 * NON-EMPTY and identical ('unknown' vs 'unknown' earns no bonus).
 */
export function normalizedIntent(intent: string | null | undefined): string {
  return (intent ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function intentsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizedIntent(a);
  return na !== '' && na === normalizedIntent(b);
}

/** Shared unit-cost DP over indexable items (chars or signature lists). */
function editDistance<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      curr.push(Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, substitution));
    }
    prev = curr;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** Classic Levenshtein distance over strings (unit costs; edge cases tested). */
export function levenshtein(a: string, b: string): number {
  return editDistance(a, b);
}

/** Edit distance over signature LISTS: substitution/removal/insertion cost 1. */
export function levenshteinSeq(a: readonly string[], b: readonly string[]): number {
  return editDistance(a, b);
}


/** sequenceScore = 1 − lev/maxLen; two empty sequences are identical ⇒ 1. */
export function sequenceScore(a: readonly string[], b: readonly string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinSeq(a, b) / maxLen;
}

/** Jaccard over sets; both empty ⇒ 1 (identical trivially). */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Precomputed per-episode mining view (built once, compared many times). */
export interface EpisodeFingerprint {
  signatures: string[];
  apps: Set<string>;
  intentKey: string;
}

export function buildEpisodeFingerprint(
  steps: ReadonlyArray<FingerprintStepInput>,
  intent: string | null | undefined,
): EpisodeFingerprint {
  return {
    signatures: steps.map(stepFingerprint),
    apps: episodeAppSet(steps),
    intentKey: normalizedIntent(intent),
  };
}

/**
 * Pinned similarity (spec §3.20):
 *   0.60·sequenceScore + 0.25·appJaccard + 0.15·(intentEqual ? 1 : 0)
 */
export function episodeSimilarity(a: EpisodeFingerprint, b: EpisodeFingerprint): number {
  return (
    SEQ_WEIGHT * sequenceScore(a.signatures, b.signatures) +
    APP_WEIGHT * jaccard(a.apps, b.apps) +
    INTENT_WEIGHT * (a.intentKey !== '' && a.intentKey === b.intentKey ? 1 : 0)
  );
}

/** Median of pairwise similarities (even counts: mean of the middle two). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1] ?? sorted[mid] ?? 0;
  const hi = sorted[mid] ?? lo;
  return sorted.length % 2 === 1 ? hi : (lo + hi) / 2;
}
