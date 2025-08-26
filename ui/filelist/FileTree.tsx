import React, { useState, useEffect } from 'react';
import { Tree, NodeApi } from 'react-arborist';

export interface FileStats {
  lines_added?: number;
  lines_removed?: number;
  is_tracked?: boolean;
  binary?: boolean;
}

export interface FileNode {
  type: 'file';
  path: string;
  name: string;
  size: number;
  modified: string;
  stats: FileStats;
  id: string;
}

export interface DirectoryNode {
  type: 'directory';
  path: string;
  name: string;
  children: (FileNode | DirectoryNode)[];
  stats: Record<string, number>;
  id: string;
}

type TreeNode = FileNode | DirectoryNode;

interface FileTreeResponse {
  tree: DirectoryNode;
}

export interface FileTreeState {
  openDirs: string[];
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
}

export interface FileTreeProps {
  projectName: string;
  sessionId?: string;
  height?: number;
  onFileOpen?: (filePath: string) => void;
}

const formatStats = (stats: FileStats | Record<string, number>): string => {
  const parts = [];
  
  if ('lines_added' in stats && stats.lines_added) {
    parts.push(`+${stats.lines_added}`);
  }
  if ('lines_removed' in stats && stats.lines_removed) {
    parts.push(`-${stats.lines_removed}`);
  }
  if ('binary' in stats && stats.binary) {
    parts.push('Binary');
  }
  if ('is_tracked' in stats && stats.is_tracked === false) {
    parts.push('New');
  }
  
  return parts.length > 0 ? `[${parts.join('/')}]` : '';
};

const transformApiData = (apiNode: any, parentPath = ''): TreeNode => {
  const nodePath = apiNode.path || parentPath;
  const name = nodePath.split('/').pop() || nodePath;
  const id = nodePath || Math.random().toString();
  
  if (apiNode.type === 'file') {
    return {
      type: 'file',
      path: nodePath,
      name,
      size: apiNode.size || 0,
      modified: apiNode.modified || '',
      stats: apiNode.stats || {},
      id
    };
  }
  
  return {
    type: 'directory',
    path: nodePath,
    name,
    children: (apiNode.children || []).map((child: any) => 
      transformApiData(child, child.path)
    ),
    stats: apiNode.stats || {},
    id
  };
};

const fetchTreeData = async (projectName: string, openDirs: string[]): Promise<DirectoryNode> => {
  const response = await fetch(`/api/filelist/${projectName}/tree`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ open_dirs: openDirs }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch tree data: ${response.statusText}`);
  }

  const data: FileTreeResponse = await response.json();
  return transformApiData(data.tree) as DirectoryNode;
};

const openInEditor = async (filePath: string, sessionId?: string): Promise<void> => {
  if (sessionId) {
    await fetch(`/api/sessions/${sessionId}/editor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_path: filePath }),
    });
  } else {
    // Use generic editor endpoint when no session ID is provided
    await fetch('/api/editor/open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_path: filePath }),
    });
  }
};

const getFileIcon = (fileName: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'tsx':
    case 'ts':
      return '⚛️';
    case 'js':
    case 'jsx':
      return '📄';
    case 'css':
    case 'scss':
      return '🎨';
    case 'html':
      return '🌐';
    case 'json':
      return '📋';
    case 'md':
      return '📝';
    case 'py':
      return '🐍';
    case 'java':
      return '☕';
    case 'cpp':
    case 'c':
      return '⚙️';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return '🖼️';
    default:
      return '📄';
  }
};

const FileTreeNode: React.FC<{ node: NodeApi<TreeNode>; onFileOpen?: (path: string) => void }> = ({ node, onFileOpen }) => {
  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.data.type === 'file' && onFileOpen) {
      onFileOpen(node.data.path);
    }
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.data.type === 'file' && onFileOpen) {
      onFileOpen(node.data.path);
    }
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    node.toggle();
  };

  return (
    <div className="file-entry">
      <div className="file-entry-content">
        {/* Expander for directories */}
        {node.data.type === 'directory' && (
          <button 
            className="expander-button"
            onClick={handleToggleClick}
          >
            {node.isOpen ? '▼' : '▶'}
          </button>
        )}
        {node.data.type === 'file' && (
          <div className="expander-placeholder"></div>
        )}
        
        {/* Icon */}
        <span className="file-icon">
          {node.data.type === 'directory' ? '📁' : getFileIcon(node.data.name)}
        </span>
        
        {/* Name */}
        <span 
          className="filename" 
          onClick={node.data.type === 'file' ? handleOpenFile : handleToggleClick}
        >
          {node.data.name}
        </span>
        
        {/* Stats */}
        <span className="stats">
          {formatStats(node.data.stats)}
        </span>
        
        {/* Edit button for files */}
        {node.data.type === 'file' && (
          <button 
            className="edit-button"
            onClick={handleEditClick}
            title={`Open ${node.data.name} in editor`}
          >
            ✏️
          </button>
        )}
      </div>
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({ 
  projectName, 
  sessionId,
  height = 400,
  onFileOpen 
}) => {
  const [state, setState] = useState<FileTreeState>({
    openDirs: [''],
    selectedPath: null,
    loading: false,
    error: null,
  });

  const [treeData, setTreeData] = useState<TreeNode[]>([]);

  const handleFileOpen = async (filePath: string) => {
    if (onFileOpen) {
      onFileOpen(filePath);
    } else if (sessionId) {
      try {
        await openInEditor(filePath, sessionId);
      } catch (error) {
        console.error('Failed to open file:', error);
        setState(prev => ({ ...prev, error: 'Failed to open file in editor' }));
      }
    }
  };

  const loadTreeData = async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const rootNode = await fetchTreeData(projectName, state.openDirs);
      setTreeData([rootNode]);
    } catch (error) {
      setState(prev => ({ 
        ...prev, 
        error: error instanceof Error ? error.message : 'Failed to load tree data' 
      }));
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  };

  useEffect(() => {
    loadTreeData();
  }, [projectName, state.openDirs]);

  const handleToggle = (id: string) => {
    // Find the node by ID and toggle its open state
    const toggleDir = (path: string, isOpen: boolean) => {
      const newOpenDirs = isOpen 
        ? state.openDirs.filter(dir => dir !== path)
        : [...state.openDirs, path];
      
      setState(prev => ({ ...prev, openDirs: newOpenDirs }));
    };

    // For now, use the ID as the path - this might need refinement
    toggleDir(id, state.openDirs.includes(id));
  };

  const handleCollapseAll = () => {
    setState(prev => ({ ...prev, openDirs: [''] })); // Keep only root directory open
  };

  if (state.loading) {
    return <div style={{ padding: '20px' }}>Loading file tree...</div>;
  }

  if (state.error) {
    return (
      <div style={{ padding: '20px', color: 'red' }}>
        <div>Error: {state.error}</div>
        <button onClick={loadTreeData} style={{ marginTop: '10px' }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="file-tree-container">
      <div className="file-tree-header">
        <span className="file-tree-title">Files</span>
        <button 
          className="file-tree-collapse-all"
          onClick={handleCollapseAll}
          disabled={state.loading}
          title="Collapse all directories"
        >
          ⊟
        </button>
      </div>
      <Tree<TreeNode>
        data={treeData}
        onToggle={handleToggle}
        height={height - 32} // Subtract header height
        indent={20}
        rowHeight={24}
      >
        {(props) => <FileTreeNode {...props} onFileOpen={handleFileOpen} />}
      </Tree>
    </div>
  );
};

export default FileTree;