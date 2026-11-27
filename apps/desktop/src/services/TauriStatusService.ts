import { invoke } from '@tauri-apps/api/core';
import { HealthResponse, IPC_CONSTANTS } from '../types/ipc';
import {
  AgentConnectionState,
  OperationalEvent,
  PROTECTION_UNMONITORED_LABEL,
} from '../types/status';
import { StatusPollResult, StatusService } from './MockStatusService';

export interface SanitizedHealthStatus {
  state: AgentConnectionState;
  health: HealthResponse | null;
  agent_version: string | null;
  browser_protection: typeof PROTECTION_UNMONITORED_LABEL;
  ide_protection: typeof PROTECTION_UNMONITORED_LABEL;
  status_reason: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * T2 Tauri StatusService: invokes the Rust backend `get_health_status` command
 * and maps only sanitized operational fields to the UI.
 */
export class TauriStatusService implements StatusService {
  private readonly now: () => Date;
  private lastReason = 'Waiting for initial health check';

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  public async fetchHealth(): Promise<StatusPollResult> {
    const res = await invoke<SanitizedHealthStatus>('get_health_status');
    const safeReason =
      typeof res.status_reason === 'string' && res.status_reason.trim().length > 0
        ? res.status_reason
        : 'Agent status unavailable';
    this.lastReason = safeReason;

    if (res.state === 'Stale') {
      return {
        connected: true,
        timedOut: true,
        health: null,
        agentVersion: res.agent_version ?? 'unknown',
        statusReason: safeReason,
      };
    }

    if ((res.state !== 'Online' && res.state !== 'Degraded') || !res.health) {
      return {
        connected: false,
        timedOut: false,
        health: null,
        agentVersion: res.agent_version ?? 'unknown',
        statusReason: safeReason,
      };
    }

    return {
      connected: true,
      timedOut: false,
      health: {
        agent_running: Boolean(res.health.agent_running),
        inspection_engine_available: Boolean(res.health.inspection_engine_available),
        protocol_version: res.health.protocol_version ?? IPC_CONSTANTS.PROTOCOL_VERSION,
      },
      agentVersion: res.agent_version ?? 'unknown',
      statusReason: safeReason,
    };
  }

  public getEvents(state: AgentConnectionState): OperationalEvent[] {
    const severity: OperationalEvent['severity'] =
      state === 'Online' ? 'info' : state === 'Offline' ? 'error' : 'warning';
    return [
      {
        id: `ipc-${state.toLowerCase()}`,
        timestampIso: this.now().toISOString(),
        severity,
        message: this.lastReason,
      },
    ];
  }
}
