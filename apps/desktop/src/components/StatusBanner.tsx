import React from 'react';
import { AgentConnectionState, STATUS_DISPLAY_MAP } from '../types/status';

export interface StatusBannerProps {
  state: AgentConnectionState;
  headline: string;
  description: string;
}

export const StatusBanner: React.FC<StatusBannerProps> = ({
  state,
  headline,
  description,
}) => {
  const meta = STATUS_DISPLAY_MAP[state];
  const stateSlug = state.toLowerCase();

  return (
    <section
      className={`ss-banner ss-banner--${stateSlug}`}
      role="status"
      aria-live="polite"
      aria-label={`Agent status: ${meta.badgeLabel}`}
    >
      <div className="ss-banner-row">
        <span className={`ss-dot ss-dot--${stateSlug}`} aria-hidden="true" />
        <span className="ss-badge">{meta.badgeLabel}</span>
      </div>
      <h2 className="ss-banner-headline">{headline}</h2>
      <p className="ss-banner-desc">{description}</p>
    </section>
  );
};
