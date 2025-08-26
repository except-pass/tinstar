export interface Project {
  name: string;
  path: string;
  created_at: string;
  default_branch?: string;
  unignore_paths: string[];
}

export interface ProjectResponse {
  success: boolean;
  message?: string;
  project?: Project;
  projects?: Project[];
}

export interface CreateProjectRequest {
  path: string;
  name?: string;
  unignore_paths?: string[];
}

export interface UpdateProjectRequest {
  unignore_paths?: string[];
}

export interface ProjectPaneState {
  projects: Project[];
  loading: boolean;
  error: string | null;
}

export interface ProjectWidgetState {
  refreshing: boolean;
  closing: boolean;
  showingSettings: boolean;
  updatingSettings: boolean;
}

export interface ProjectSettingsState {
  unignorePaths: string;
  originalPaths: string[];
  saving: boolean;
  error: string | null;
}

export const COLOR_PALETTE = [
  '#C6A77B', // Desert Sand
  '#8B5A2B', // Saddle Brown
  '#A04020', // Rust Red
  '#4B4B4B', // Gunmetal Gray
  '#D4AF37', // Prairie Gold
  '#556B2F', // Cactus Green
  '#9AB6C3', // Dusty Sky
  '#2E1B0F', // Charred Wood
] as const;

export const pathsToText = (paths: string[]): string => paths.join('\n');
export const textToPaths = (text: string): string[] => 
  text.split('\n').map(path => path.trim()).filter(path => path.length > 0);