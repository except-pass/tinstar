import React, { useEffect, useState } from 'react';

interface FileStats {
  path: string;
  size: number;
  modified: string;
  stats: Record<string, any>;
}

interface DirectoryNode {
  path: string;
  children: Array<FileStats | DirectoryNode>;
  stats: Record<string, any>;
}

interface FileListProps {
  sessionId: string;
  project: string;
}

interface FileTreeItem {
  type: 'file' | 'directory';
  path: string;
  children?: FileTreeItem[];
  stats?: Record<string, any>;
  size?: number;
  modified?: string;
}

export const FileList: React.FC<FileListProps> = ({ sessionId, project }) => {
  const [fileTree, setFileTree] = useState<FileTreeItem | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([''])); // Start with root expanded
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showChangedOnly, setShowChangedOnly] = useState<boolean>(true);

  const fetchFileTree = async () => {
    if (!sessionId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/filelist/worktree/${sessionId}/tree`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          open_dirs: Array.from(expandedDirs),
          show_changed_only: showChangedOnly
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch file tree: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setFileTree({ type: 'directory', ...data.tree });
    } catch (err: any) {
      setError(err.message);
      setFileTree(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFileTree();
  }, [sessionId, expandedDirs, showChangedOnly]);

  const toggleDirectory = (dirPath: string) => {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath);
    } else {
      newExpanded.add(dirPath);
    }
    setExpandedDirs(newExpanded);
  };

  const renderStats = (stats: Record<string, any>) => {
    if (!stats || Object.keys(stats).length === 0) return null;
    
    const { lines_added = 0, lines_removed = 0 } = stats;
    if (lines_added === 0 && lines_removed === 0) return null;
    
    return (
      <span className="file-stats">
        {lines_added > 0 && <span className="added">+{lines_added}</span>}
        {lines_removed > 0 && <span className="removed">-{lines_removed}</span>}
      </span>
    );
  };

  const handleEditClick = async (filePath: string) => {
    try {
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
    } catch (error) {
      console.error('Failed to open file in editor:', error);
    }
  };

  const renderTreeItem = (item: FileTreeItem, depth: number = 0): React.ReactNode => {
    const indentStyle = { paddingLeft: `${depth * 16}px` };
    
    if (item.type === 'file') {
      return (
        <div key={item.path} className="file-item" style={indentStyle}>
          <span className="file-icon">📄</span>
          <span className="file-name">{item.path.split('/').pop()}</span>
          {renderStats(item.stats || {})}
          <button 
            className="edit-button"
            onClick={(e) => {
              e.stopPropagation();
              handleEditClick(item.path);
            }}
            title={`Edit ${item.path.split('/').pop()}`}
          >
            ✏️
          </button>
        </div>
      );
    }
    
    // Directory
    const isExpanded = expandedDirs.has(item.path);
    const hasChildren = item.children && item.children.length > 0;
    const dirName = item.path === '' ? 'Worktree' : item.path.split('/').pop();
    
    return (
      <div key={item.path} className="directory-item">
        <div 
          className="directory-header" 
          style={indentStyle}
          onClick={() => toggleDirectory(item.path)}
        >
          <span className="directory-toggle">
            {hasChildren ? (isExpanded ? '▼' : '▶') : ''}
          </span>
          <span className="directory-icon">📁</span>
          <span className="directory-name">{dirName}</span>
          {renderStats(item.stats || {})}
        </div>
        {isExpanded && hasChildren && (
          <div className="directory-children">
            {item.children?.map((child) => renderTreeItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="file-list-loading">Loading files...</div>;
  }

  if (error) {
    return <div className="file-list-error">Error: {error}</div>;
  }

  if (!fileTree) {
    return <div className="file-list-empty">No file tree available</div>;
  }

  return (
    <div className="file-list">
      <div className="file-list-header">
        <h4>Files</h4>
        <label className="file-list-filter">
          <input
            type="checkbox"
            checked={showChangedOnly}
            onChange={(e) => setShowChangedOnly(e.target.checked)}
          />
          Show changed files only
        </label>
      </div>
      <div className="file-tree">
        {renderTreeItem(fileTree)}
      </div>
    </div>
  );
};

export default FileList;