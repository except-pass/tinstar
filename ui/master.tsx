import React from 'react';
import { createRoot } from 'react-dom/client';
import { MasterUI } from './MasterUI';

const App: React.FC = () => {
  const handleAgentSelect = (sessionId: string) => {
    console.log('Master UI - Agent selected:', sessionId);
  };

  const handleProjectSelect = (projectName: string) => {
    console.log('Master UI - Project selected:', projectName);
  };

  return (
    <MasterUI 
      onAgentSelect={handleAgentSelect}
      onProjectSelect={handleProjectSelect}
    />
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}