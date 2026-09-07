import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '@computer-history/protocol';
import { CONSTANTS } from '../src/config.js';

const SWIFT_SOURCES = path.join(import.meta.dirname, '..', '..', 'recorder-macos', 'Sources', 'RecorderApp');

/**
 * Cross-language numeric contracts have no shared source of truth: the Swift
 * recorder re-states values that live in TS CONSTANTS / the protocol package.
 * These pins fail loudly when one side moves without the other — the drift
 * class behind the round-37 watchdog/helper collision and the round-38 audit.
 */
function swiftLiteral(file: string, pattern: RegExp): number {
  const source = readFileSync(path.join(SWIFT_SOURCES, file), 'utf8');
  const match = source.match(pattern);
  if (!match || match[1] === undefined) {
    throw new Error(`${file}: pattern ${pattern} not found — Swift source shape changed; update this pin`);
  }
  return Number(match[1].replace(/_/g, ''));
}

describe('Swift/TS constant parity', () => {
  it('FrameCodec.maxPayloadSize matches CONSTANTS.maxFrameBytes', () => {
    // Framing.swift pins the wire cap the recorder enforces on its own
    // encoder; a skew makes the daemon accept frames Swift refuses (silent
    // spool pile-up) or vice versa.
    const swiftCap = swiftLiteral(path.join('IPC', 'Framing.swift'), /static let maxPayloadSize\s*=\s*([\d_]+)/);
    expect(swiftCap).toBe(CONSTANTS.maxFrameBytes);
  });

  it('Swift protocolVersion matches PROTOCOL_VERSION', () => {
    // ProtocolModels.swift's shared constant feeds ClientHello/RequestFrame/
    // EventBatch and the mismatch diagnostics; a skew fails every handshake.
    const swiftVersion = swiftLiteral(path.join('IPC', 'ProtocolModels.swift'), /^let protocolVersion\s*=\s*(\d+)$/m);
    expect(swiftVersion).toBe(PROTOCOL_VERSION);
  });

  it('AppState turn watchdog nests above CONSTANTS.promptTimeoutMs', () => {
    // The daemon aborts a stalled chat.run at promptTimeoutMs and delivers
    // chat_error; the app's local watchdog must fire strictly later (10 s
    // margin) so it only covers a dead transport. Raising promptTimeoutMs
    // without moving this side makes the app fail turns the daemon would
    // still have recovered.
    const swiftSeconds = swiftLiteral(
      path.join('App', 'AppState.swift'),
      /var turnPendingWatchdogInterval:\s*TimeInterval\s*=\s*([\d_]+)/,
    );
    expect(swiftSeconds).toBe(CONSTANTS.promptTimeoutMs / 1000 + 10);
  });
});
