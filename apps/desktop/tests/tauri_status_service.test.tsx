import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { App } from '../src/App';
import { TauriStatusService } from '../src/services/TauriStatusService';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('TauriStatusService sanitized frontend boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders Online, Degraded, Stale, and Offline from sanitized get_health_status without tokens or console logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke
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
      })
      .mockResolvedValueOnce({
        state: 'Degraded',
        health: {
          agent_running: true,
          inspection_engine_available: false,
          protocol_version: 1,
        },
        agent_version: '0.1.0-dev',
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: 'Inspection engine unavailable',
      })
      .mockResolvedValueOnce({
        state: 'Stale',
        health: null,
        agent_version: null,
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: 'Health check exceeded 3000 ms timeout',
      })
      .mockResolvedValueOnce({
        state: 'Offline',
        health: null,
        agent_version: null,
        browser_protection: 'Unknown (unmonitored)',
        ide_protection: 'Unknown (unmonitored)',
        status_reason: 'Agent socket unavailable',
      });

    const service = new TauriStatusService();
    render(<App service={service} />);

    // Initial poll -> Online
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedInvoke).toHaveBeenCalledWith('get_health_status');
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Active (Core Ready)');
    expect(screen.getAllByText('Unknown (unmonitored)')).toHaveLength(2);
    expect(screen.queryByRole('group', { name: 'Mock state preview' })).not.toBeInTheDocument();

    // 5s poll -> Degraded
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Inspection Engine Degraded');
    expect(screen.getAllByText('Unknown (unmonitored)')).toHaveLength(2);

    // 5s poll -> Stale
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Agent Status Unknown / Unresponsive');

    // 5s poll -> Offline
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Offline (Agent Not Running)');

    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
