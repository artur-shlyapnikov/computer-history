

import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// R9-T6: the fallback case below pins daemonHome() against a FIXED homedir
// instead of the developer's machine.
const { FAKE_HOMEDIR } = vi.hoisted(() => ({ FAKE_HOMEDIR: '/Users/fake-ch-home' }));
vi.mock('node:os', () => ({
  homedir: (): string => FAKE_HOMEDIR,
}));

import {
  DEFAULT_LLM_MODELS,
  HOME_ENV_VAR,
  daemonHome,
  loadLlmConfig,
  resolvePaths,
} from '../src/config.js';

/**
 * Direct unit pins for env/path resolution (design P3-1): LLM env overrides
 * win over the pinned defaults, absent vars degrade to defaults WITHOUT
 * throwing (documented at config.ts — jobs fail through the retry schedule
 * instead), resolvePaths derives the run/spool/logs/data layout, and
 * daemonHome honors COMPUTER_HISTORY_HOME.
 *
 * loadLlmConfig/resolvePaths take their inputs as parameters, so no
 * process.env mutation is needed there; only the daemonHome case touches
 * process.env (saved + restored).
 */

describe('loadLlmConfig', () => {
  it('env overrides win over DEFAULT_LLM_MODELS', () => {
    const config = loadLlmConfig({
      COMPUTER_HISTORY_CHAT_MODEL: 'acme/chat-x',
      COMPUTER_HISTORY_BACKGROUND_MODEL: 'acme/bg-y',
    });
    expect(config.chatModel).toBe('acme/chat-x');
    expect(config.backgroundModel).toBe('acme/bg-y');
  });

  it('absent vars fall back to the pinned defaults without throwing', () => {
    const config = loadLlmConfig({});
    expect(config.chatModel).toBe(DEFAULT_LLM_MODELS.chatModel);
    expect(config.backgroundModel).toBe(DEFAULT_LLM_MODELS.backgroundModel);
    expect('agentDir' in config).toBe(false);
  });

  it('a non-empty COMPUTER_HISTORY_LLM_AGENT_DIR is carried through as agentDir', () => {
    const config = loadLlmConfig({ COMPUTER_HISTORY_LLM_AGENT_DIR: '/tmp/pi-agent' });
    expect(config.agentDir).toBe('/tmp/pi-agent');
  });

  it('an EMPTY agent-dir value behaves like an absent one', () => {
    const config = loadLlmConfig({
      COMPUTER_HISTORY_LLM_AGENT_DIR: '',
      COMPUTER_HISTORY_CHAT_MODEL: 'acme/chat-x',
    });
    expect('agentDir' in config).toBe(false);
    expect(config.chatModel).toBe('acme/chat-x');
  });

  it('per-variable precedence: only one of the two model ids overridden', () => {
    const config = loadLlmConfig({ COMPUTER_HISTORY_BACKGROUND_MODEL: 'acme/bg-y' });
    expect(config.chatModel).toBe(DEFAULT_LLM_MODELS.chatModel);
    expect(config.backgroundModel).toBe('acme/bg-y');
  });
});

describe('resolvePaths', () => {
  it('derives the run/spool/logs/data layout under a given home', () => {
    const paths = resolvePaths('/tmp/fake-home');
    expect(paths.homeDir).toBe('/tmp/fake-home');
    expect(paths.runDir).toBe('/tmp/fake-home/run');
    expect(paths.spoolDir).toBe('/tmp/fake-home/spool');
    expect(paths.logsDir).toBe('/tmp/fake-home/logs');
    expect(paths.dataDir).toBe('/tmp/fake-home/data');
    expect(paths.dbPath).toBe('/tmp/fake-home/data/history.db');
    expect(paths.socketPath).toBe('/tmp/fake-home/run/history.sock');
    expect(paths.logPath).toBe('/tmp/fake-home/logs/daemon.jsonl');
  });
});

describe('daemonHome', () => {
  it(`honors ${HOME_ENV_VAR}`, () => {
    const previous = process.env[HOME_ENV_VAR];
    process.env[HOME_ENV_VAR] = '/tmp/ch-home-override';
    try {
      expect(daemonHome()).toBe('/tmp/ch-home-override');
    } finally {
      if (previous === undefined) delete process.env[HOME_ENV_VAR];
      else process.env[HOME_ENV_VAR] = previous;
    }
  });

  it('falls back to ~/Library/Application Support/ComputerHistory when unset', () => {
    const previous = process.env[HOME_ENV_VAR];
    const FAKE_HOMEDIR = '/Users/fake-ch-home';
    delete process.env[HOME_ENV_VAR];
    try {
      expect(daemonHome()).toBe(
        path.join(FAKE_HOMEDIR, 'Library', 'Application Support', 'ComputerHistory'),
      );
    } finally {
      if (previous !== undefined) process.env[HOME_ENV_VAR] = previous;
    }
  });
});

