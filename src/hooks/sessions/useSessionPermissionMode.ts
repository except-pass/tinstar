import { useQuery } from "@tanstack/react-query";
import { honoClient } from "@/lib/api/client";
import type { PermissionMode } from "@/server/service/claude-code/types";

export const useSessionPermissionMode = (
  projectId: string,
  sessionId: string,
) => {
  return useQuery({
    queryKey: ["sessionPermissionMode", projectId, sessionId],
    queryFn: async () => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ]["permission-mode"].$get({
        param: { projectId, sessionId },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch session permission mode");
      }

      const data = await response.json();
      return data.mode as PermissionMode;
    },
  });
};
