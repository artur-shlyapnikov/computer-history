/**
 * Wire-safety sanitization for daemon-side text (issue W2). JavaScript strings
 * may carry unpaired UTF-16 surrogates (e.g. from `\ud800` escapes in LLM
 * output or captured content): TypeBox/JSON.parse accept them on the Node
 * side, but Swift's JSONDecoder rejects the ENTIRE frame at parse time
 * (NSCocoaErrorDomain 3840), so one poisoned string silently drops a chat
 * delta, episode summary or history payload on every Apple client.
 *
 * Sanitize once at the text entry/emission boundary — not throughout the
 * pipeline — so every string that reaches the wire (and SQLite, which
 * round-trips the escapes verbatim) is well-formed UTF-16.
 */

const REPLACEMENT = '\uFFFD';

/** Lone high surrogate (D800–DBFF) not followed by a low surrogate. */
const HIGH = 0xd800;
/** Lone low surrogate (DC00–DFFF) without a preceding high surrogate. */
const LOW_END = 0xdfff;
const HIGH_END = 0xdbff;

function isSurrogate(code: number): boolean {
  return code >= HIGH && code <= LOW_END;
}

/**
 * Replaces every unpaired surrogate with U+FFFD and leaves everything else
 * byte-for-byte intact: valid surrogate pairs (astral emoji etc.), BMP text,
 * existing replacement characters. Returns the input string itself when it
 * contains no surrogates at all (the overwhelmingly common case), so the hot
 * ingest path allocates nothing.
 */
export function replaceWellFormedTarget(s: string): string {
  let hasSurrogate = false;
  for (let i = 0; i < s.length; i += 1) {
    if (isSurrogate(s.charCodeAt(i))) {
      hasSurrogate = true;
      break;
    }
  }
  if (!hasSurrogate) return s;

  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= HIGH && code <= HIGH_END) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Well-formed pair: keep both units (the astral character survives).
        out += s.slice(i, i + 2);
        i += 1;
      } else {
        out += REPLACEMENT;
      }
    } else if (isSurrogate(code)) {
      out += REPLACEMENT;
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}
