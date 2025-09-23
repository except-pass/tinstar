import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProjectPill } from "@/components/ui/project-pill";
import type { Project } from "@/server/service/types";

interface ProjectSelectorProps {
  projects: Project[];
  value?: string;
  onValueChange: (projectId: string) => void;
  placeholder?: string;
  className?: string;
}

export function ProjectSelector({ 
  projects, 
  value, 
  onValueChange, 
  placeholder = "Select a project...",
  className 
}: ProjectSelectorProps) {
  const selectedProject = projects.find(p => p.id === value);

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className}>
        <SelectValue>
          {selectedProject ? (
            <div className="flex items-center gap-2">
              <ProjectPill 
                projectId={selectedProject.id} 
                projectName={selectedProject.meta.projectName || selectedProject.id}
                size="sm"
              />
            </div>
          ) : (
            placeholder
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <div className="flex items-center gap-2">
              <ProjectPill 
                projectId={project.id} 
                projectName={project.meta.projectName || project.id}
                size="sm"
              />
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}