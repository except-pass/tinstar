import React from 'react';
import { ProjectPane } from './ProjectPane';

const ProjectPaneDemo: React.FC = () => {
  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      <ProjectPane />
      <div style={{ flex: 1, padding: '20px', backgroundColor: '#f8f9fa' }}>
        <h1>Project Pane Demo</h1>
        <p>The Project Pane should appear on the left side of this page.</p>
        <p>
          To test:
        </p>
        <ul>
          <li>Click "New Project" to add projects (requires backend API)</li>
          <li>Try the refresh, settings, and close buttons</li>
          <li>Check that colors cycle through the Western theme palette</li>
          <li>Test the settings dialog for editing unignore paths</li>
        </ul>
        <p>
          <strong>Note:</strong> This demo requires the Tinstar backend API to be running 
          for full functionality.
        </p>
      </div>
    </div>
  );
};

export default ProjectPaneDemo;