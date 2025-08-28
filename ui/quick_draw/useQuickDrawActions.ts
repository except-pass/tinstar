import { useEffect } from 'react';
import { quickDrawRegistry } from './QuickDrawRegistry';

interface AgentSelection {
  agents: Array<{ id: string; name?: string }>;
  onAgentClick?: (sessionId: string) => void;
  onNewAgent?: () => void;
}

export const useQuickDrawActions = ({
  agents,
  onAgentClick,
  onNewAgent
}: AgentSelection) => {
  
  // Register agent namespace and actions
  useEffect(() => {
    // Register the agents namespace
    quickDrawRegistry.registerNamespace('a', 'Agents', 'Select and manage agents');
    
    // Register agent selection actions (a,s,d,f,g,h,j,k,l,;)
    const agentKeys = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';'];
    
    agents.forEach((agent, index) => {
      if (index < agentKeys.length) {
        const key = agentKeys[index];
        const agentName = agent.name || `Agent ${index + 1}`;
        
        quickDrawRegistry.registerAction('a', key, {
          namespace: 'a',
          key,
          action: () => {
            if (onAgentClick) {
              onAgentClick(agent.id);
            }
          },
          description: `Select ${agentName}`,
          targetSelector: `[data-testid="agent-${agent.id}"]`
        });
      }
    });
    
    // Register new agent action
    if (onNewAgent) {
      quickDrawRegistry.registerAction('a', 'n', {
        namespace: 'a',
        key: 'n',
        action: onNewAgent,
        description: 'Create new agent',
        targetSelector: '[data-testid="new-agent-button"]'
      });
    }
    
    // Cleanup function to remove actions when agents change
    return () => {
      // Clear all 'a' namespace actions
      const namespace = quickDrawRegistry['actions']?.['a'];
      if (namespace) {
        Object.keys(namespace).forEach(key => {
          delete namespace[key];
        });
      }
    };
  }, [agents, onAgentClick, onNewAgent]);
};