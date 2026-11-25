import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { MockStatusService } from '../src/services/MockStatusService';
import { encodeLengthPrefixedFrame } from '../src/types/ipc';

describe('Accessibility, scope indicators, and privacy invariants', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes accessible status banner and switches across all 4 states without a disable toggle', async () => {
    const service = new MockStatusService({ initialScenario: 'Online' });
    render(<App service={service} />);

    await act(async () => {
      await Promise.resolve();
    });

    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveAttribute('aria-live', 'polite');
    expect(statusRegion).toHaveTextContent('ShadowShield Active (Core Ready)');

    // Browser and IDE protection must read Unknown (unmonitored)
    const unmonitoredItems = screen.getAllByText('Unknown (unmonitored)');
    expect(unmonitoredItems).toHaveLength(2);

    // No disable protection toggle or switch anywhere in the UI
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/disable protection/i)).not.toBeInTheDocument();

    // Switch to Degraded
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Degraded' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Inspection Engine Degraded');

    // Switch to Offline
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Offline' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('ShadowShield Offline (Agent Not Running)');
  });

  it('never logs prompts, tokens, or raw IPC payloads to console diagnostics', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // Exercise frame encoding with neutral RFC 5737 fixture and placeholder token
    encodeLengthPrefixedFrame({
      protocol_version: 1,
      request_id: 'auth-test-1',
      type: 'Authenticate',
      payload: { token: '0'.repeat(64) },
    });
    encodeLengthPrefixedFrame({
      protocol_version: 1,
      request_id: 'inspect-test-1',
      type: 'Inspect',
      payload: {
        source: 'DesktopTray',
        ai_service: 'chatgpt',
        content: '192.0.2.53',
        timestamp: 1728691200000,
      },
    });

    const service = new MockStatusService({ initialScenario: 'Online' });
    render(<App service={service} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
