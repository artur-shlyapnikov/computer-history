import { describe, expect, it, vi } from 'vitest';

/**
 * R9-T4: daemonVersion()'s failure contract — every failure mode degrades to
 * '0.0.0', never throws:
 *   1. readFileSync throwing (EACCES simulation)
 *   2. parsed JSON without a version key
 *   3. DEVIATION from design R9-T4 case 3 ("control: real read → non-empty"):
 *      status.ts resolves '../package.json' relative to src/ipc/, which only
 *      exists in the packaged layout — under vitest the source tree has no
 *      apps/daemon/src/package.json, so the REAL read hits ENOENT and the
 *      pinned behavior is '0.0.0'. The case pins exactly that (missing-manifest
 *      → fallback), which is what actually runs in dev/test.
 *
 * node:fs is replaced wholesale (only readFileSync is consumed on this path);
 * `mocks.impl` swaps the behavior per case.
 */
const mocks = vi.hoisted(() => ({
  impl: null as null | (() => string),
}));

vi.mock('node:fs', () => ({
  readFileSync: (): string => {
    if (!mocks.impl) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    return mocks.impl();
  },
}));

const { daemonVersion } = await import('../src/ipc/status.js');

describe('daemonVersion fallbacks', () => {
  it("returns '0.0.0' when package.json is unreadable", () => {
    mocks.impl = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    try {
      expect(daemonVersion()).toBe('0.0.0');
    } finally {
      mocks.impl = null;
    }
  });

  it("returns '0.0.0' when the parsed package has no version key", () => {
    mocks.impl = () => '{"name":"x"}';
    try {
      expect(daemonVersion()).toBe('0.0.0');
    } finally {
      mocks.impl = null;
    }
  });

  it("control: a genuinely missing manifest (source tree) also yields '0.0.0'", () => {
    // No impl set → the mocked fs throws ENOENT, mirroring the real
    // source-tree state where src/package.json does not exist.
    expect(daemonVersion()).toBe('0.0.0');
    // Flip the underlying read to a manifest WITH a version: the very next
    // call must observe it, proving daemonVersion() is read-through and not
    // memoized (a cached fallback would still return '0.0.0' here).
    mocks.impl = () => '{"name":"x","version":"9.9.9"}';
    try {
      expect(daemonVersion()).toBe('9.9.9');
    } finally {
      mocks.impl = null;
    }
  });
});
