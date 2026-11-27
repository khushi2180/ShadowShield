import { useCallback, useEffect, useRef, useState } from 'react';
import { IPC_CONSTANTS } from '../types/ipc';
import {
  DesktopStatusSnapshot,
  PROTECTION_UNMONITORED_LABEL,
  STATUS_DISPLAY_MAP,
} from '../types/status';
import { StatusService, buildStatusSnapshot } from '../services/MockStatusService';

export interface UseAgentStatusOptions {
  service: StatusService;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
}

export interface UseAgentStatusResult {
  snapshot: DesktopStatusSnapshot;
  isPolling: boolean;
  refreshNow: () => Promise<void>;
}

function createInitialSnapshot(): DesktopStatusSnapshot {
  const meta = STATUS_DISPLAY_MAP.Offline;
  return {
    state: 'Offline',
    headline: meta.headline,
    description: meta.description,
    agentVersion: '0.1.0-mock',
    protocolVersion: IPC_CONSTANTS.PROTOCOL_VERSION,
    inspectionEngineAvailable: false,
    browserProtection: PROTECTION_UNMONITORED_LABEL,
    ideProtection: PROTECTION_UNMONITORED_LABEL,
    lastCheckedIso: new Date(0).toISOString(),
    events: [],
  };
}

export function useAgentStatus({
  service,
  pollIntervalMs = IPC_CONSTANTS.TRAY_POLL_INTERVAL_MS,
  healthTimeoutMs = IPC_CONSTANTS.TRAY_HEALTH_TIMEOUT_MS,
}: UseAgentStatusOptions): UseAgentStatusResult {
  const [snapshot, setSnapshot] = useState<DesktopStatusSnapshot>(createInitialSnapshot);
  const [isPolling, setIsPolling] = useState<boolean>(false);
  const inFlightRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const abortRef = useRef<AbortController | null>(null);

  const runPoll = useCallback(async () => {
    if (inFlightRef.current || !mountedRef.current) {
      return;
    }

    inFlightRef.current = true;
    setIsPolling(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        service.fetchHealth(controller.signal).then((res) => ({ kind: 'ok' as const, res })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            resolve({ kind: 'timeout' });
          }, healthTimeoutMs);
        }),
      ]);

      if (!mountedRef.current) {
        return;
      }

      if (result.kind === 'timeout') {
        const events = service.getEvents('Stale');
        setSnapshot(
          buildStatusSnapshot({
            connected: true,
            timedOut: true,
            health: null,
            agentVersion: '0.1.0-mock',
            events,
            now: new Date(),
          }),
        );
      } else {
        const nextState = result.res.timedOut
          ? 'Stale'
          : !result.res.connected || !result.res.health?.agent_running
            ? 'Offline'
            : result.res.health.inspection_engine_available
              ? 'Online'
              : 'Degraded';
        const events = service.getEvents(nextState);
        setSnapshot(
          buildStatusSnapshot({
            connected: result.res.connected,
            timedOut: Boolean(result.res.timedOut),
            health: result.res.health,
            agentVersion: result.res.agentVersion,
            events,
            now: new Date(),
          }),
        );
      }
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const events = service.getEvents('Offline');
      setSnapshot(
        buildStatusSnapshot({
          connected: false,
          timedOut: false,
          health: null,
          agentVersion: '0.1.0-mock',
          events,
          now: new Date(),
        }),
      );
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      inFlightRef.current = false;
      if (mountedRef.current) {
        setIsPolling(false);
      }
    }
  }, [healthTimeoutMs, service]);

  useEffect(() => {
    mountedRef.current = true;
    void runPoll();

    const intervalId = setInterval(() => {
      void runPoll();
    }, pollIntervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
      abortRef.current?.abort();
    };
  }, [pollIntervalMs, runPoll]);

  return {
    snapshot,
    isPolling,
    refreshNow: runPoll,
  };
}
