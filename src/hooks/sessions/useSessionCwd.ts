import { useQuery } from "@tanstack/react-query";
import { honoClient } from "@/lib/api/client";

export const useSessionCwd = (projectId: string, sessionId: string) => {
  return useQuery({
    queryKey: ["session-cwd", projectId, sessionId],
    queryFn: async () => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ].cwd.$get({
        param: { projectId, sessionId },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch session CWD");
      }

      const result = await response.json();

      if ("error" in result) {
        throw new Error(result.error as string);
      }

      return result.cwd;
    },
  });
};
