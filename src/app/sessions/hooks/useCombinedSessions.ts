import { useSuspenseQuery } from "@tanstack/react-query";
import { honoClient } from "../../../lib/api/client";

export const combinedSessionsQueryConfig = {
  queryKey: ["sessions", "all"],
  queryFn: async () => {
    const response = await honoClient.api.sessions.all.$get();
    const { sessions } = await response.json();
    return sessions;
  },
} as const;

export const useCombinedSessions = () => {
  return useSuspenseQuery({
    queryKey: combinedSessionsQueryConfig.queryKey,
    queryFn: combinedSessionsQueryConfig.queryFn,
  });
};