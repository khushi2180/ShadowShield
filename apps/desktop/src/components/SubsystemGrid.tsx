import React from 'react';
import { DesktopStatusSnapshot, PROTECTION_UNMONITORED_LABEL } from '../types/status';

export interface SubsystemGridProps {
  snapshot: DesktopStatusSnapshot;
}

export const SubsystemGrid: React.FC<SubsystemGridProps> = ({ snapshot }) => {
  const agentOnline = snapshot.state === 'Online' || snapshot.state === 'Degraded';
  const engineReady = snapshot.inspectionEngineAvailable;

  return (
    <section className="ss-section" aria-labelledby="subsystem-heading">
      <h2 id="subsystem-heading" className="ss-section-title">
        Subsystem &amp; Protection Scope
      </h2>
      <div className="ss-grid">
        <div className="ss-tile">
          <span className="ss-tile-label">Core Agent</span>
          <span
            className={`ss-tile-value ${
              snapshot.state === 'Stale'
                ? 'ss-tone-warn'
                : agentOnline
                  ? 'ss-tone-ok'
                  : 'ss-tone-off'
            }`}
          >
            {snapshot.state === 'Stale'
              ? 'Unresponsive'
              : agentOnline
                ? 'Running'
                : 'Not Running'}
          </span>
        </div>

        <div className="ss-tile">
          <span className="ss-tile-label">Inspection Engine</span>
          <span
            className={`ss-tile-value ${
              engineReady
                ? 'ss-tone-ok'
                : snapshot.state === 'Degraded'
                  ? 'ss-tone-warn'
                  : 'ss-tone-neutral'
            }`}
          >
            {engineReady
              ? 'Core Ready'
              : snapshot.state === 'Degraded'
                ? 'Degraded'
                : 'Unavailable'}
          </span>
        </div>

        <div className="ss-tile">
          <span className="ss-tile-label">Browser Protection</span>
          <span className="ss-tile-value ss-tone-neutral">
            {PROTECTION_UNMONITORED_LABEL}
          </span>
        </div>

        <div className="ss-tile">
          <span className="ss-tile-label">IDE Protection</span>
          <span className="ss-tile-value ss-tone-neutral">
            {PROTECTION_UNMONITORED_LABEL}
          </span>
        </div>
      </div>
    </section>
  );
};
