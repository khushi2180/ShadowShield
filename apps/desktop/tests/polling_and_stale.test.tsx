import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { MockStatusService } from '../src/services/MockStatusService';
import { IPC_CONSTANTS } from '../src/types/ipc';

describe('5s poll scheduling and 3s stale timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls Health every 5 seconds and stops polling on unmount', async () => {
    const service = new MockStatusService({ initialScenario: 'Online' });
    const fetchSpy = vi.spyOn(service, 'fetchHealth');

    const { unmount } = render(<App service={service} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('ShadowShield Active (Core Ready)')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('marks agent as Stale when Health exceeds 3,000 ms timeout', async () => {
    const service = new MockStatusService({
      initialScenario: 'Stale',
      staleDelayMs: 5_000,
    });

    render(<App service={service} />);

    // Before 3s timeout expires, it has not resolved to Stale yet
    await act(async () => {
      vi.advanceTimersByTime(2_900);
      await Promise.resolve();
    });
    expect(screen.queryByText('Agent Status Unknown / Unresponsive')).not.toBeInTheDocument();

    // Crossing the 3,000 ms TRAY_HEALTH_TIMEOUT_MS triggers Stale state
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(screen.getByText('Agent Status Unknown / Unresponsive')).toBeInTheDocument();
  });
});
