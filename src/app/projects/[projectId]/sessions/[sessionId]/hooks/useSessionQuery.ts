import { useSuspenseQuery } from "@tanstack/react-query";
import { honoClient } from "../../../../../../lib/api/client";

export const sessionQueryConfig = (projectId: string, sessionId: string) =>
  ({
    queryKey: ["sessions", sessionId],
    queryFn: async () => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ].$get({
        param: {
          projectId,
          sessionId,
        },
      });

      return response.json();
    },
  }) as const;

export const useSessionQuery = (projectId: string, sessionId: string) => {
  return useSuspenseQuery({
    ...sessionQueryConfig(projectId, sessionId),
  });
};
