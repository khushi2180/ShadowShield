import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { App } from '../src/App';
import { TauriStatusService } from '../src/services/TauriStatusService';
import { IPC_CONSTANTS } from '../src/types/ipc';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('T4 frontend hardening and fail-closed boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails closed to Offline on unknown status or invoke rejection without retaining stale Online', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke
      .mockResolvedValueOnce({
        state: 'Online',
        health: {
          agent_running: true,
          inspection_engine_available: true,
          protocol_version: 1,
        },
        agent_version: '0.1.0-t4',
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: 'Core inspection engine ready',
      })
      .mockResolvedValueOnce({
        state: 'UnexpectedState' as unknown as 'Offline',
        health: null,
        agent_version: null,
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: '',
      })
      .mockRejectedValueOnce(new Error('IPC bridge unavailable'));

    const service = new TauriStatusService();
    render(<App service={service} />);

    // Poll 1 -> Online
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Active (Core Ready)');
    expect(screen.getAllByText('Unknown (unmonitored)')).toHaveLength(2);

    // Poll 2 -> Unknown state must fail closed to Offline, never retain Online
    await act(async () => {
      vi.advanceTimersByTime(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Offline (Agent Not Running)');
    expect(screen.getAllByText('Unknown (unmonitored)')).toHaveLength(2);

    // Poll 3 -> Tauri invoke rejection fails closed to Offline
    await act(async () => {
      vi.advanceTimersByTime(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Offline (Agent Not Running)');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
