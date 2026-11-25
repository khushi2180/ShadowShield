import { HealthResponse, IPC_CONSTANTS } from './ipc';

export type AgentConnectionState = 'Online' | 'Offline' | 'Stale' | 'Degraded';

export type ProtectionScopeValue = 'Unknown (unmonitored)';

export interface StatusDisplayMeta {
  state: AgentConnectionState;
  headline: string;
  description: string;
  badgeLabel: string;
}

export interface OperationalEvent {
  id: string;
  timestampIso: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface DesktopStatusSnapshot {
  state: AgentConnectionState;
  headline: string;
  description: string;
  agentVersion: string;
  protocolVersion: number;
  inspectionEngineAvailable: boolean;
  browserProtection: ProtectionScopeValue;
  ideProtection: ProtectionScopeValue;
  lastCheckedIso: string;
  events: OperationalEvent[];
}

export const PROTECTION_UNMONITORED_LABEL: ProtectionScopeValue = 'Unknown (unmonitored)';

export const STATUS_DISPLAY_MAP: Record<AgentConnectionState, StatusDisplayMeta> = {
  Online: {
    state: 'Online',
    headline: 'ShadowShield Active (Core Ready)',
    description: 'Local agent is running and the deterministic inspection engine is ready.',
    badgeLabel: 'Online',
  },
  Offline: {
    state: 'Offline',
    headline: 'ShadowShield Offline (Agent Not Running)',
    description: 'Unable to reach local agent socket. Protection fails closed until agent starts.',
    badgeLabel: 'Offline',
  },
  Stale: {
    state: 'Stale',
    headline: 'Agent Status Unknown / Unresponsive',
    description: `Health check exceeded the ${IPC_CONSTANTS.TRAY_HEALTH_TIMEOUT_MS} ms timeout window.`,
    badgeLabel: 'Unknown / Stale',
  },
  Degraded: {
    state: 'Degraded',
    headline: 'Inspection Engine Degraded',
    description: 'Agent process is running, but the inspection engine is unavailable.',
    badgeLabel: 'Degraded',
  },
};

/**
 * Derives tray connection state strictly from IPC HealthResponse or transport outcome
 * per Section 8.1 of docs/v2/IPC_CONTRACT.md.
 */
export function deriveAgentState(params: {
  connected: boolean;
  timedOut?: boolean;
  health?: HealthResponse | null;
}): AgentConnectionState {
  if (params.timedOut) {
    return 'Stale';
  }
  if (!params.connected || !params.health || !params.health.agent_running) {
    return 'Offline';
  }
  if (!params.health.inspection_engine_available) {
    return 'Degraded';
  }
  return 'Online';
}
