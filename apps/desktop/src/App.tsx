import React, { useMemo, useState } from 'react';
import { ActivityFeed } from './components/ActivityFeed';
import { FooterControls } from './components/FooterControls';
import { Header } from './components/Header';
import { StatusBanner } from './components/StatusBanner';
import { SubsystemGrid } from './components/SubsystemGrid';
import { useAgentStatus } from './hooks/useAgentStatus';
import { MockStatusService, StatusService } from './services/MockStatusService';
import { TauriStatusService, isTauriRuntime } from './services/TauriStatusService';
import { AgentConnectionState } from './types/status';

export interface AppProps {
  service?: StatusService;
}

export const App: React.FC<AppProps> = ({ service: injectedService }) => {
  const { service, mockService } = useMemo(() => {
    if (injectedService) {
      return {
        service: injectedService,
        mockService: injectedService instanceof MockStatusService ? injectedService : null,
      };
    }
    if (isTauriRuntime()) {
      return {
        service: new TauriStatusService(),
        mockService: null,
      };
    }
    const fallbackMock = new MockStatusService({ initialScenario: 'Online' });
    return {
      service: fallbackMock,
      mockService: fallbackMock,
    };
  }, [injectedService]);

  const [selectedScenario, setSelectedScenario] = useState<AgentConnectionState>(
    mockService?.getScenario() ?? 'Online',
  );

  const { snapshot, isPolling, refreshNow } = useAgentStatus({ service });

  const handleSelectScenario = (scenario: AgentConnectionState) => {
    if (!mockService) {
      return;
    }
    mockService.setScenario(scenario);
    setSelectedScenario(scenario);
    void refreshNow();
  };

  return (
    <main className="ss-tray-shell" aria-label="ShadowShield Desktop Tray">
      <Header
        agentVersion={snapshot.agentVersion}
        protocolVersion={snapshot.protocolVersion}
        isMockMode={mockService !== null}
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
        showMockControls={mockService !== null}
      />
    </main>
  );
};

export default App;
