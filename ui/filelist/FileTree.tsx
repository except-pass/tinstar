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
    console.warn('No session ID provided for editor opening');
  }
};

const FileTreeNode: React.FC<{ node: NodeApi<TreeNode>; onFileOpen?: (path: string) => void }> = ({ node, onFileOpen }) => {
  const handleOpenFile = () => {
    if (node.data.type === 'file' && onFileOpen) {
      onFileOpen(node.data.path);
    }
  };

  return (
    <div 
      className="file-entry"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '2px 0',
        cursor: node.data.type === 'file' ? 'pointer' : 'default'
      }}
      onClick={node.data.type === 'file' ? handleOpenFile : undefined}
    >
      <span className="filename" style={{ flex: 1 }}>
        {node.data.name}
      </span>
      <span className="stats" style={{ 
        fontSize: '0.8em', 
        color: '#666',
        marginRight: '8px'
      }}>
        {formatStats(node.data.stats)}
      </span>
      {node.data.type === 'file' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleOpenFile();
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px'
          }}
          title="Open in editor"
        >
          ✏️
        </button>
      )}
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
      <Tree<TreeNode>
        data={treeData}
        onToggle={handleToggle}
        height={height}
        indent={20}
        rowHeight={24}
      >
        {(props) => <FileTreeNode {...props} onFileOpen={handleFileOpen} />}
      </Tree>
    </div>
  );
};

export default FileTree;