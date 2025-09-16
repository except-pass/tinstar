import { useCallback, useMemo } from "react";
import type { Conversation } from "@/lib/conversation-schema";

export const useSidechain = (conversations: Conversation[]) => {
  const conversationMap = useMemo(() => {
    return new Map<string, Conversation>(
      conversations
        .filter((conv) => conv.type !== "summary")
        .map((conv) => [conv.uuid, conv] as const),
    );
  }, [conversations]);

  const getRootConversationRecursive = useCallback(
    (conversation: Conversation): Conversation => {
      if (conversation.type === "summary") {
        return conversation;
      }

      if (conversation.parentUuid === null) {
        return conversation;
      }

      const parent = conversationMap.get(conversation.parentUuid);
      if (parent === undefined) {
        return conversation;
      }

      return getRootConversationRecursive(parent);
    },
    [conversationMap],
  );

  const sidechainConversationGroups = useMemo(() => {
    const filtered = conversations
      .filter((conv) => conv.type !== "summary")
      .filter((conv) => conv.isSidechain === true);

    const groups = new Map<string, Conversation[]>();

    for (const conv of filtered) {
      const rootConversation = getRootConversationRecursive(conv);

      if (rootConversation.type === "summary") {
        // たぶんない
        continue;
      }

      if (groups.has(rootConversation.uuid)) {
        groups.get(rootConversation.uuid)?.push(conv);
      } else {
        groups.set(rootConversation.uuid, [conv]);
      }
    }

    return groups;
  }, [conversations, getRootConversationRecursive]);

  const isRootSidechain = useCallback(
    (conversation: Conversation) => {
      if (conversation.type === "summary") {
        return false;
      }

      return sidechainConversationGroups.has(conversation.uuid);
    },
    [sidechainConversationGroups],
  );

  const getSidechainConversations = useCallback(
    (rootUuid: string) => {
      return sidechainConversationGroups.get(rootUuid) ?? [];
    },
    [sidechainConversationGroups],
  );

  return {
    isRootSidechain,
    getSidechainConversations,
  };
};
