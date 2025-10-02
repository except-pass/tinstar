import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { sessionQueryConfig } from "@/hooks/sessions/useSessionQuery";

type SessionWithProject = {
  session: { id: string };
  projectId: string;
  projectName: string;
};

/**
 * Prefetches conversation data for visible sessions to enable instant switching
 */
export const usePrefetchVisibleSessions = (
  visibleSessions: SessionWithProject[],
) => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Prefetch data for all visible sessions
    for (const sessionWithProject of visibleSessions) {
      const { session, projectId } = sessionWithProject;
      const config = sessionQueryConfig(projectId, session.id);

      // Check if data is already cached
      const cachedData = queryClient.getQueryData(config.queryKey);

      // Only prefetch if not already cached
      if (!cachedData) {
        queryClient.prefetchQuery(config);
      }
    }
  }, [visibleSessions, queryClient]);
};
