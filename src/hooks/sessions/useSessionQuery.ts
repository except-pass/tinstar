import { useSuspenseQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { honoClient } from "@/lib/api/client";
import { aliveTasksAtom } from "@/lib/atoms/aliveTasksAtom";

export const sessionQueryConfig = (projectId: string, sessionId: string) => ({
  queryKey: ["sessions", sessionId] as const,
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
});

export const useSessionQuery = (projectId: string, sessionId: string) => {
  const aliveTasks = useAtomValue(aliveTasksAtom);

  // Check if there's a running task for this session
  const hasRunningTask = aliveTasks.some(
    (task) => task.sessionId === sessionId && task.status === "running",
  );

  return useSuspenseQuery({
    ...sessionQueryConfig(projectId, sessionId),
    // Aggressively refetch when invalidated
    staleTime: 0,
    // Retry failed queries to handle race conditions with file creation
    retry: 3,
    retryDelay: 1000,
    // Poll every second when a task is running for this session
    refetchInterval: hasRunningTask ? 1000 : false,
  });
};
