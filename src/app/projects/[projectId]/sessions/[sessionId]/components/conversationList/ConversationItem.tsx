import type { FC } from "react";
import type { Conversation } from "@/lib/conversation-schema";
import type { ToolResultContent } from "@/lib/conversation-schema/content/ToolResultContentSchema";
import { SidechainConversationModal } from "../conversationModal/SidechainConversationModal";
import { AssistantConversationContent } from "./AssistantConversationContent";
import { MetaConversationContent } from "./MetaConversationContent";
import { SummaryConversationContent } from "./SummaryConversationContent";
import { SystemConversationContent } from "./SystemConversationContent";
import { UserConversationContent } from "./UserConversationContent";

const getUserContentKey = (
  content: unknown,
  index: number,
  conversationUuid: string,
) => {
  if (typeof content === "string") {
    return `user_${conversationUuid}_text_${index}`;
  }

  if (content && typeof content === "object" && "type" in content) {
    const c = content as { type: string; tool_use_id?: string };
    if (c.type === "tool_result") {
      return `user_${conversationUuid}_tool_result_${c.tool_use_id}_${index}`;
    }
    if (c.type === "image") {
      return `user_${conversationUuid}_image_${index}`;
    }
    if (c.type === "text") {
      return `user_${conversationUuid}_text_${index}`;
    }
  }

  return `user_${conversationUuid}_content_${index}`;
};

const getAssistantContentKey = (
  content: unknown,
  index: number,
  conversationUuid: string,
) => {
  if (content && typeof content === "object" && "type" in content) {
    const c = content as { type: string; id?: string; tool_use_id?: string };
    if (c.type === "tool_use") {
      return `assistant_${conversationUuid}_tool_use_${c.id}`;
    }
    if (c.type === "tool_result") {
      return `assistant_${conversationUuid}_tool_result_${c.tool_use_id}_${index}`;
    }
    if (c.type === "text") {
      return `assistant_${conversationUuid}_text_${index}`;
    }
    if (c.type === "thinking") {
      return `assistant_${conversationUuid}_thinking_${index}`;
    }
  }

  return `assistant_${conversationUuid}_content_${index}`;
};

export const ConversationItem: FC<{
  conversation: Conversation;
  getToolResult: (toolUseId: string) => ToolResultContent | undefined;
  isRootSidechain: (conversation: Conversation) => boolean;
  getSidechainConversations: (rootUuid: string) => Conversation[];
  isResponse?: boolean;
  isInEditGroup?: boolean;
}> = ({
  conversation,
  getToolResult,
  isRootSidechain,
  getSidechainConversations,
  isResponse = false,
  isInEditGroup = false,
}) => {
  if (conversation.type === "summary") {
    return (
      <SummaryConversationContent>
        {conversation.summary}
      </SummaryConversationContent>
    );
  }

  if (conversation.type === "system") {
    return (
      <SystemConversationContent level={conversation.level}>
        {conversation.content}
      </SystemConversationContent>
    );
  }

  // sidechain = subtasks
  if (conversation.isSidechain) {
    // Non-root items display content in modal, so don't render here
    if (!isRootSidechain(conversation)) {
      return null;
    }

    return (
      <SidechainConversationModal
        conversation={conversation}
        sidechainConversations={getSidechainConversations(
          conversation.uuid,
        ).map((original) => {
          if (original.type === "summary") return original;
          return {
            ...original,
            isSidechain: false,
          };
        })}
        getToolResult={getToolResult}
      />
    );
  }

  if (conversation.type === "user") {
    if (!conversation.message) {
      return (
        <div className="text-muted-foreground text-sm">[Metadata entry]</div>
      );
    }

    const userConversationJsx =
      typeof conversation.message.content === "string" ? (
        <UserConversationContent
          content={conversation.message.content}
          id={`message-${conversation.uuid}`}
        />
      ) : (
        <ul className="w-full" id={`message-${conversation.uuid}`}>
          {conversation.message.content.map((content, index) => (
            <li
              key={getUserContentKey(
                content as unknown,
                index,
                conversation.uuid,
              )}
            >
              <UserConversationContent content={content} />
            </li>
          ))}
        </ul>
      );

    return conversation.isMeta === true ? (
      // Make expandable with default collapsed state
      <MetaConversationContent>{userConversationJsx}</MetaConversationContent>
    ) : (
      userConversationJsx
    );
  }

  if (conversation.type === "assistant") {
    return (
      <ul className="w-full">
        {conversation.message.content.map((content, index) => (
          <li
            key={getAssistantContentKey(
              content as unknown,
              index,
              conversation.uuid,
            )}
          >
            <AssistantConversationContent
              content={content}
              getToolResult={getToolResult}
              isResponse={isResponse && content.type === "text"}
              isInEditGroup={isInEditGroup}
            />
          </li>
        ))}
      </ul>
    );
  }

  return null;
};
