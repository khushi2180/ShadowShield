import React from 'react';
import { AgentConnectionState } from '../types/status';

export interface FooterControlsProps {
  activeScenario: AgentConnectionState;
  onSelectScenario: (scenario: AgentConnectionState) => void;
  onRefresh: () => void;
  isPolling: boolean;
  lastCheckedIso: string;
}

const SCENARIOS: AgentConnectionState[] = ['Online', 'Offline', 'Stale', 'Degraded'];

export const FooterControls: React.FC<FooterControlsProps> = ({
  activeScenario,
  onSelectScenario,
  onRefresh,
  isPolling,
  lastCheckedIso,
}) => {
  return (
    <footer className="ss-footer">
      <div className="ss-mock-controls" role="group" aria-label="Mock state preview">
        <span className="ss-mock-label">Mock State:</span>
        <div className="ss-mock-buttons">
          {SCENARIOS.map((scenario) => (
            <button
              key={scenario}
              type="button"
              className={`ss-btn ${activeScenario === scenario ? 'ss-btn--active' : ''}`}
              aria-pressed={activeScenario === scenario}
              onClick={() => onSelectScenario(scenario)}
            >
              {scenario}
            </button>
          ))}
        </div>
      </div>

      <div className="ss-footer-meta">
        <span className="ss-posture-note">
          Fail-closed DLP active when agent runs
        </span>
        <button
          type="button"
          className="ss-btn"
          onClick={onRefresh}
          disabled={isPolling}
        >
          {isPolling ? 'Checking...' : 'Check Now'}
        </button>
      </div>
      <div className="ss-timestamp" aria-label="Last health check timestamp">
        Last checked: {lastCheckedIso === new Date(0).toISOString() ? 'Pending' : lastCheckedIso}
      </div>
    </footer>
  );
};
