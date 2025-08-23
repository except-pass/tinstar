import React from 'react';
import { createRoot } from 'react-dom/client';
import { FileTree } from './filelist';

const Demo: React.FC = () => {
  const handleFileOpen = (filePath: string) => {
    console.log('Opening file:', filePath);
    alert(`Would open file: ${filePath}`);
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>FileTree Demo</h1>
      <div style={{ width: '400px', height: '500px' }}>
        <FileTree 
          projectName="example-project"
          height={400}
          onFileOpen={handleFileOpen}
        />
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Demo />);
}