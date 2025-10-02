"use client";

import { useAtom } from "jotai";
import { Filter, Check, ChevronDown } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ProjectPill } from "@/components/ui/project-pill";
import { cn } from "@/lib/utils";
import { projectFilterAtom } from "../store/projectFilterAtom";
import { useProjects } from "@/app/projects/hooks/useProjects";

interface ProjectFilterProps {
  className?: string;
}

export function ProjectFilter({ className }: ProjectFilterProps) {
  const [filterState, setFilterState] = useAtom(projectFilterAtom);
  const { data: projects } = useProjects();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  if (!projects) return null;

  const hasActiveFilter = !filterState.showAll;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
    
    return undefined;
  }, [isOpen]);

  const handleShowAllChange = (checked: boolean) => {
    if (checked) {
      setFilterState({
        showAll: true,
        selectedProjectIds: new Set(),
      });
    } else {
      setFilterState({
        showAll: false,
        selectedProjectIds: new Set(), // Start with no projects selected
      });
    }
  };

  const handleProjectToggle = (projectId: string, checked: boolean) => {
    const newSelectedIds = new Set(filterState.selectedProjectIds);
    
    if (checked) {
      newSelectedIds.add(projectId);
    } else {
      newSelectedIds.delete(projectId);
    }

    // If all projects are selected, switch to "show all"
    const allSelected = newSelectedIds.size === projects.length;
    
    setFilterState({
      showAll: allSelected,
      selectedProjectIds: allSelected ? new Set() : newSelectedIds,
    });
  };

  return (
    <div className={cn("relative", className)} ref={dropdownRef}>
      <Button
        ref={buttonRef}
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "gap-2 transition-colors",
          hasActiveFilter && "bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100",
        )}
      >
        <Filter className={cn("w-4 h-4", hasActiveFilter && "text-blue-600")} />
        Projects
        {hasActiveFilter && (
          <span className="bg-blue-600 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] h-5 flex items-center justify-center">
            {filterState.selectedProjectIds.size}
          </span>
        )}
        <ChevronDown className={cn("w-4 h-4 transition-transform", isOpen && "rotate-180")} />
      </Button>

      {isOpen && (
        <div className="absolute top-full left-0 z-50 mt-1 w-72 bg-white border border-border rounded-md shadow-lg p-2">
          <div className="space-y-2">
            {/* Show All Option */}
            <div className="flex items-center space-x-2 p-2 hover:bg-muted/50 rounded">
              <Checkbox
                id="show-all"
                checked={filterState.showAll}
                onCheckedChange={handleShowAllChange}
              />
              <label
                htmlFor="show-all"
                className="flex-1 text-sm font-medium cursor-pointer"
              >
                Show All Projects
              </label>
              {filterState.showAll && (
                <Check className="w-4 h-4 text-green-600" />
              )}
            </div>

            {/* Separator */}
            <div className="border-t" />

            {/* Individual Project Options */}
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {projects.map((project) => {
                const isSelected = filterState.showAll || filterState.selectedProjectIds.has(project.id);
                
                return (
                  <div
                    key={project.id}
                    className="flex items-center space-x-2 p-2 hover:bg-muted/50 rounded"
                  >
                    <Checkbox
                      id={`project-${project.id}`}
                      checked={isSelected}
                      disabled={filterState.showAll}
                      onCheckedChange={(checked) => 
                        handleProjectToggle(project.id, checked as boolean)
                      }
                    />
                    <label
                      htmlFor={`project-${project.id}`}
                      className="flex-1 cursor-pointer"
                    >
                      <ProjectPill
                        projectId={project.id}
                        projectName={project.meta.projectName || project.id}
                        size="sm"
                      />
                    </label>
                    {isSelected && !filterState.showAll && (
                      <Check className="w-4 h-4 text-green-600" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer with count */}
            {projects.length > 0 && (
              <>
                <div className="border-t" />
                <div className="text-xs text-muted-foreground p-2">
                  {filterState.showAll 
                    ? `Showing all ${projects.length} projects`
                    : `${filterState.selectedProjectIds.size} of ${projects.length} projects selected`
                  }
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}