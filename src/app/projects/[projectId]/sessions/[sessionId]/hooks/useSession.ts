import { useCallback, useMemo } from "react";
import { useSessionQuery } from "./useSessionQuery";

export const useSession = (projectId: string, sessionId: string) => {
  const query = useSessionQuery(projectId, sessionId);

  const toolResultMap = useMemo(() => {
    const entries = query.data.session.conversations.flatMap((conversation) => {
      if (conversation.type !== "user" || !conversation.message) {
        return [];
      }

      if (typeof conversation.message.content === "string") {
        return [];
      }

      return conversation.message.content.flatMap((message) => {
        if (typeof message === "string") {
          return [];
        }

        if (message.type !== "tool_result") {
          return [];
        }

        return [[message.tool_use_id, message] as const];
      });
    });

    return new Map(entries);
  }, [query.data.session.conversations]);

  const getToolResult = useCallback(
    (toolUseId: string) => {
      return toolResultMap.get(toolUseId);
    },
    [toolResultMap],
  );

  return {
    session: query.data.session,
    conversations: query.data.session.conversations,
    getToolResult,
  };
};
