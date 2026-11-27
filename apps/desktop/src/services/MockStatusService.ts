import {
  HealthRequest,
  HealthResponse,
  IPC_CONSTANTS,
  IpcRequest,
  IpcResponse,
} from '../types/ipc';
import {
  AgentConnectionState,
  DesktopStatusSnapshot,
  OperationalEvent,
  PROTECTION_UNMONITORED_LABEL,
  STATUS_DISPLAY_MAP,
  deriveAgentState,
} from '../types/status';

export interface StatusPollResult {
  connected: boolean;
  timedOut?: boolean;
  health: HealthResponse | null;
  agentVersion: string;
  statusReason?: string;
}

export interface StatusService {
  fetchHealth(signal?: AbortSignal): Promise<StatusPollResult>;
  getEvents(state: AgentConnectionState): OperationalEvent[];
}

export interface MockStatusServiceOptions {
  initialScenario?: AgentConnectionState;
  staleDelayMs?: number;
  now?: () => Date;
}

const NEUTRAL_EVENTS_BY_STATE: Record<AgentConnectionState, Omit<OperationalEvent, 'timestampIso'>[]> = {
  Online: [
    {
      id: 'evt-online-1',
      severity: 'info',
      message: 'Mock IPC handshake and Health check succeeded.',
    },
    {
      id: 'evt-online-2',
      severity: 'info',
      message: 'Core deterministic inspection engine is ready.',
    },
  ],
  Offline: [
    {
      id: 'evt-offline-1',
      severity: 'error',
      message: 'Mock UDS endpoint unavailable (ECONNREFUSED).',
    },
    {
      id: 'evt-offline-2',
      severity: 'warning',
      message: 'Fail-closed posture active while agent is offline.',
    },
  ],
  Stale: [
    {
      id: 'evt-stale-1',
      severity: 'warning',
      message: `Health request exceeded ${IPC_CONSTANTS.TRAY_HEALTH_TIMEOUT_MS} ms threshold.`,
    },
  ],
  Degraded: [
    {
      id: 'evt-degraded-1',
      severity: 'warning',
      message: 'Agent is reachable, but inspection engine reported unavailable.',
    },
  ],
};

/**
 * Deterministic mock status service for T1 Tray Scaffold.
 * Does not connect to a real daemon or log sensitive payloads.
 */
export class MockStatusService implements StatusService {
  private scenario: AgentConnectionState;
  private readonly staleDelayMs: number;
  private readonly now: () => Date;
  private requestCounter = 0;

  constructor(options: MockStatusServiceOptions = {}) {
    this.scenario = options.initialScenario ?? 'Online';
    this.staleDelayMs = options.staleDelayMs ?? IPC_CONSTANTS.TRAY_HEALTH_TIMEOUT_MS + 500;
    this.now = options.now ?? (() => new Date());
  }

  public getScenario(): AgentConnectionState {
    return this.scenario;
  }

  public setScenario(next: AgentConnectionState): void {
    this.scenario = next;
  }

  public buildHealthRequest(): IpcRequest<HealthRequest> {
    this.requestCounter += 1;
    return {
      protocol_version: IPC_CONSTANTS.PROTOCOL_VERSION,
      request_id: `tray-health-${this.requestCounter}`,
      type: 'Health',
      payload: {},
    };
  }

  public async fetchHealth(signal?: AbortSignal): Promise<StatusPollResult> {
    // Construct request envelope to verify contract shape without persisting or logging it.
    const request = this.buildHealthRequest();
    const current = this.scenario;

    if (current === 'Stale') {
      await waitWithAbort(this.staleDelayMs, signal);
    }

    if (current === 'Offline') {
      return {
        connected: false,
        health: null,
        agentVersion: '0.1.0-mock',
      };
    }

    const response: IpcResponse<HealthResponse> = {
      protocol_version: IPC_CONSTANTS.PROTOCOL_VERSION,
      request_id: request.request_id,
      type: 'HealthResponse',
      payload: {
        agent_running: true,
        inspection_engine_available: current === 'Online',
        protocol_version: IPC_CONSTANTS.PROTOCOL_VERSION,
      },
    };

    return {
      connected: true,
      health: response.payload,
      agentVersion: '0.1.0-mock',
    };
  }

  public getEvents(state: AgentConnectionState): OperationalEvent[] {
    const timestampIso = this.now().toISOString();
    return NEUTRAL_EVENTS_BY_STATE[state].map((evt) => ({
      ...evt,
      timestampIso,
    }));
  }
}

export function buildStatusSnapshot(params: {
  connected: boolean;
  timedOut: boolean;
  health: HealthResponse | null;
  agentVersion: string;
  events: OperationalEvent[];
  now: Date;
}): DesktopStatusSnapshot {
  const state = deriveAgentState({
    connected: params.connected,
    timedOut: params.timedOut,
    health: params.health,
  });
  const meta = STATUS_DISPLAY_MAP[state];

  return {
    state,
    headline: meta.headline,
    description: meta.description,
    agentVersion: params.agentVersion,
    protocolVersion: params.health?.protocol_version ?? IPC_CONSTANTS.PROTOCOL_VERSION,
    inspectionEngineAvailable: Boolean(params.health?.inspection_engine_available && state === 'Online'),
    browserProtection: PROTECTION_UNMONITORED_LABEL,
    ideProtection: PROTECTION_UNMONITORED_LABEL,
    lastCheckedIso: params.now.toISOString(),
    events: params.events,
  };
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
