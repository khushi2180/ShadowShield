import React from 'react';
import { OperationalEvent } from '../types/status';

export interface ActivityFeedProps {
  events: OperationalEvent[];
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({ events }) => {
  return (
    <section className="ss-section" aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="ss-section-title">
        Operational Events
      </h2>
      {events.length === 0 ? (
        <p className="ss-empty">No operational events recorded yet.</p>
      ) : (
        <ul className="ss-events">
          {events.map((event) => (
            <li key={event.id} className={`ss-event ss-event--${event.severity}`}>
              <span className="ss-event-msg">{event.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
