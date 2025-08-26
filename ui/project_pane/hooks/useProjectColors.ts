import { useMemo } from 'react';
import { COLOR_PALETTE } from '../types';

interface UseProjectColorsReturn {
  getProjectColor: (index: number) => string;
  getProjectColorIndex: (projectName: string, projects: string[]) => number;
}

export const useProjectColors = (): UseProjectColorsReturn => {
  const getProjectColor = useMemo(() => 
    (index: number): string => COLOR_PALETTE[index % COLOR_PALETTE.length],
    []
  );

  const getProjectColorIndex = useMemo(() => 
    (projectName: string, projects: string[]): number => {
      // Find consistent index for this project name
      const sortedProjects = [...projects].sort();
      const index = sortedProjects.indexOf(projectName);
      return index >= 0 ? index : 0;
    },
    []
  );

  return {
    getProjectColor,
    getProjectColorIndex,
  };
};