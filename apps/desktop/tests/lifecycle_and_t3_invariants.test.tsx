import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { App } from '../src/App';
import { TauriStatusService } from '../src/services/TauriStatusService';
import { IPC_CONSTANTS } from '../src/types/ipc';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('T3 lifecycle, agent-independent startup, and recovery invariants', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts cleanly when agent is Offline and recovers to Online on subsequent 5s poll', async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke
      .mockResolvedValueOnce({
        state: 'Offline',
        health: null,
        agent_version: null,
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: 'Agent socket unavailable',
      })
      .mockResolvedValueOnce({
        state: 'Online',
        health: {
          agent_running: true,
          inspection_engine_available: true,
          protocol_version: 1,
        },
        agent_version: '0.1.0-dev',
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: 'Core inspection engine ready',
      });

    const service = new TauriStatusService();
    render(<App service={service} />);

    // Startup Offline
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Offline (Agent Not Running)');
    expect(screen.getAllByText('Unknown (unmonitored)')).toHaveLength(2);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/disable protection/i)).not.toBeInTheDocument();

    // Recovery after 5s poll
    await act(async () => {
      vi.advanceTimersByTime(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Active (Core Ready)');
    expect(screen.getAllByText('Unknown (unmonitored)')).toHaveLength(2);
  });
});
