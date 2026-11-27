import React from 'react';

export interface HeaderProps {
  agentVersion: string;
  protocolVersion: number;
  isMockMode?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  agentVersion,
  protocolVersion,
  isMockMode = false,
}) => {
  return (
    <header className="ss-header">
      <div className="ss-brand">
        <span className="ss-shield-mark" aria-hidden="true">
          SS
        </span>
        <div>
          <h1 className="ss-title">ShadowShield</h1>
          <p className="ss-subtitle">
            {isMockMode ? 'Desktop Tray Monitor (Mock Mode)' : 'Desktop Tray Monitor'}
          </p>
        </div>
      </div>
      <div className="ss-meta" aria-label="Agent and protocol version">
        <span>v{agentVersion}</span>
        <span aria-hidden="true">·</span>
        <span>IPC v{protocolVersion}</span>
      </div>
    </header>
  );
};
