import React, { useMemo, useState } from 'react';
import { ActivityFeed } from './components/ActivityFeed';
import { FooterControls } from './components/FooterControls';
import { Header } from './components/Header';
import { StatusBanner } from './components/StatusBanner';
import { SubsystemGrid } from './components/SubsystemGrid';
import { useAgentStatus } from './hooks/useAgentStatus';
import { MockStatusService } from './services/MockStatusService';
import { AgentConnectionState } from './types/status';

export interface AppProps {
  service?: MockStatusService;
}

export const App: React.FC<AppProps> = ({ service: injectedService }) => {
  const service = useMemo(
    () => injectedService ?? new MockStatusService({ initialScenario: 'Online' }),
    [injectedService],
  );
  const [selectedScenario, setSelectedScenario] = useState<AgentConnectionState>(
    service.getScenario(),
  );

  const { snapshot, isPolling, refreshNow } = useAgentStatus({ service });

  const handleSelectScenario = (scenario: AgentConnectionState) => {
    service.setScenario(scenario);
    setSelectedScenario(scenario);
    void refreshNow();
  };

  return (
    <main className="ss-tray-shell" aria-label="ShadowShield Desktop Tray">
      <Header
        agentVersion={snapshot.agentVersion}
        protocolVersion={snapshot.protocolVersion}
      />
      <StatusBanner
        state={snapshot.state}
        headline={snapshot.headline}
        description={snapshot.description}
      />
      <SubsystemGrid snapshot={snapshot} />
      <ActivityFeed events={snapshot.events} />
      <FooterControls
        activeScenario={selectedScenario}
        onSelectScenario={handleSelectScenario}
        onRefresh={() => void refreshNow()}
        isPolling={isPolling}
        lastCheckedIso={snapshot.lastCheckedIso}
      />
    </main>
  );
};

export default App;
