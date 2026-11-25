import { describe, expect, it } from 'vitest';
import {
  IPC_CONSTANTS,
  decodeLengthPrefixedFrame,
  encodeLengthPrefixedFrame,
} from '../src/types/ipc';
import { MockStatusService } from '../src/services/MockStatusService';
import { deriveAgentState } from '../src/types/status';

describe('IPC contract constants & framing', () => {
  it('matches frozen V2 IPC contract constants', () => {
    expect(IPC_CONSTANTS.PROTOCOL_VERSION).toBe(1);
    expect(IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES).toBe(10_485_760);
    expect(IPC_CONSTANTS.HANDSHAKE_TIMEOUT_MS).toBe(5_000);
    expect(IPC_CONSTANTS.SERVER_PROCESSING_DEADLINE_MS).toBe(8_000);
    expect(IPC_CONSTANTS.CLIENT_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(IPC_CONSTANTS.TRAY_HEALTH_TIMEOUT_MS).toBe(3_000);
    expect(IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS).toBe(5_000);
  });

  it('encodes and decodes 4-byte LE length-prefixed JSON frames', () => {
    const request = {
      protocol_version: 1,
      request_id: 'tray-health-1',
      type: 'Health',
      payload: {},
    };
    const frame = encodeLengthPrefixedFrame(request);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(0, true)).toBe(frame.byteLength - 4);
    expect(decodeLengthPrefixedFrame(frame)).toEqual(request);
  });

  it('rejects frames whose 4-byte header exceeds 10 MiB without reading payload', () => {
    const oversizedHeader = new Uint8Array(8);
    new DataView(oversizedHeader.buffer).setUint32(0, IPC_CONSTANTS.MAX_FRAME_LENGTH_BYTES + 1, true);
    expect(() => decodeLengthPrefixedFrame(oversizedHeader)).toThrow(/message_too_large/);
  });
});

describe('MockStatusService & state derivation', () => {
  it('transitions cleanly across Online, Offline, and Degraded scenarios', async () => {
    const service = new MockStatusService({ initialScenario: 'Online' });

    const online = await service.fetchHealth();
    expect(online.connected).toBe(true);
    expect(online.health).toEqual({
      agent_running: true,
      inspection_engine_available: true,
      protocol_version: 1,
    });
    expect(deriveAgentState({ connected: online.connected, health: online.health })).toBe('Online');

    service.setScenario('Degraded');
    const degraded = await service.fetchHealth();
    expect(degraded.connected).toBe(true);
    expect(degraded.health).toEqual({
      agent_running: true,
      inspection_engine_available: false,
      protocol_version: 1,
    });
    expect(deriveAgentState({ connected: degraded.connected, health: degraded.health })).toBe(
      'Degraded',
    );

    service.setScenario('Offline');
    const offline = await service.fetchHealth();
    expect(offline.connected).toBe(false);
    expect(offline.health).toBeNull();
    expect(deriveAgentState({ connected: offline.connected, health: offline.health })).toBe(
      'Offline',
    );
  });

  it('derives Stale when health check times out', () => {
    expect(deriveAgentState({ connected: true, timedOut: true, health: null })).toBe('Stale');
  });
});
