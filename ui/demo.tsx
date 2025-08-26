import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileTree } from './filelist';
import { ProjectPane } from './project_pane';
import { AgentPane } from './agent_pane';

const Demo: React.FC = () => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  const handleFileOpen = (filePath: string) => {
    console.log('Opening file:', filePath);
    alert(`Would open file: ${filePath}`);
  };

  const handleAgentClick = (sessionId: string) => {
    setSelectedAgentId(sessionId);
    console.log('Selected agent:', sessionId);
  };

  return (
    <div style={{ 
      display: 'flex', 
      height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    }}>
      <AgentPane 
        onAgentClick={handleAgentClick}
        selectedAgentId={selectedAgentId}
      />
      <ProjectPane />
      <div style={{ 
        flex: 1, 
        padding: '20px',
        overflow: 'auto'
      }}>
        <h1>Tinstar UI Demo</h1>
        
        {selectedAgentId && (
          <div style={{
            padding: '16px',
            backgroundColor: '#f8f9fa',
            borderRadius: '6px',
            marginBottom: '20px'
          }}>
            <h3>Selected Agent: {selectedAgentId}</h3>
            <p>This demonstrates the agent selection functionality. The agent pane on the left allows selecting agents, which can be used by other UI components.</p>
          </div>
        )}
        
        <h2>FileTree Component</h2>
        <div style={{ 
          border: '1px solid #e1e5e9',
          borderRadius: '6px',
          overflow: 'hidden',
          maxWidth: '600px'
        }}>
          <FileTree 
            projectName="example-project"
            height={400}
            onFileOpen={handleFileOpen}
          />
        </div>
        
        <div style={{ marginTop: '20px' }}>
          <h2>UI Components Status</h2>
          <ul style={{ fontSize: '14px', lineHeight: '1.6' }}>
            <li>✅ <strong>Agent Pane</strong>: Shows active agents grouped by project with real-time status</li>
            <li>✅ <strong>Project Pane</strong>: Manages projects with color-coded organization</li>
            <li>✅ <strong>FileTree</strong>: Displays file hierarchies with git statistics</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Demo />);
}