import { useCallback, useMemo } from "react";
import type { SessionDetail } from "@/server/service/types";
import { useSessionQuery } from "./useSessionQuery";

type SessionResponse = {
  session: SessionDetail;
};

export const useSession = (projectId: string, sessionId: string) => {
  const query = useSessionQuery(projectId, sessionId);
  const data = query.data as SessionResponse;

  const toolResultMap = useMemo(() => {
    const entries = data.session.conversations.flatMap((conversation) => {
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
  }, [data.session.conversations]);

  const getToolResult = useCallback(
    (toolUseId: string) => {
      return toolResultMap.get(toolUseId);
    },
    [toolResultMap],
  );

  return {
    session: data.session,
    conversations: data.session.conversations,
    getToolResult,
  };
};
