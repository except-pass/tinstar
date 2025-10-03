import { useSuspenseQuery } from "@tanstack/react-query";
import { honoClient } from "@/lib/api/client";
import type { Project } from "@/server/service/types";

export const projetsQueryConfig = {
  queryKey: ["projects"],
  queryFn: async () => {
    const response = await honoClient.api.projects.$get();
    const { projects } = await response.json();
    return projects.map((project) => ({
      ...project,
      meta: {
        ...project.meta,
        lastModifiedAt: project.meta.lastModifiedAt
          ? new Date(project.meta.lastModifiedAt)
          : null,
      },
    })) as Project[];
  },
} as const;

export const useProjects = () => {
  return useSuspenseQuery<Project[]>({
    queryKey: projetsQueryConfig.queryKey,
    queryFn: projetsQueryConfig.queryFn,
  });
};
