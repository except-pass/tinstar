import { useSuspenseQuery } from "@tanstack/react-query";
import { honoClient } from "../../../../lib/api/client";

export const projectQueryConfig = (projectId: string) =>
  ({
    queryKey: ["projects", projectId],
    queryFn: async () => {
      const response = await honoClient.api.projects[":projectId"].$get({
        param: { projectId },
      });

      return await response.json();
    },
  }) as const;

export const useProject = (projectId: string) => {
  return useSuspenseQuery({
    ...projectQueryConfig(projectId),
    refetchOnReconnect: true,
  });
};
