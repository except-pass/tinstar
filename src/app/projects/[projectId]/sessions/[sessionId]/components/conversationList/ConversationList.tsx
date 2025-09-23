"use client";

import { AlertTriangle, ChevronRight, ExternalLink } from "lucide-react";
import { type FC, useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { StatusDot } from "@/components/ui/status-dot";
import type { Conversation } from "@/lib/conversation-schema";
import type { ToolResultContent } from "@/lib/conversation-schema/content/ToolResultContentSchema";
import type { AssistantMessageContent } from "@/lib/conversation-schema/message/AssistantMessageSchema";
import type { ErrorJsonl } from "../../../../../../../server/service/types";
import { useSidechain } from "../../hooks/useSidechain";
import { ConversationItem } from "./ConversationItem";

const getConversationKey = (conversation: Conversation) => {
  if (conversation.type === "user") {
    return `user_${conversation.uuid}`;
  }

  if (conversation.type === "assistant") {
    return `assistant_${conversation.uuid}`;
  }

  if (conversation.type === "system") {
    return `system_${conversation.uuid}`;
  }

  if (conversation.type === "summary") {
    return `summary_${conversation.leafUuid}`;
  }

  throw new Error(`Unknown conversation type: ${conversation}`);
};

const SchemaErrorDisplay: FC<{ errorLine: string }> = ({ errorLine }) => {
  return (
    <li className="w-full flex justify-start">
      <div className="w-full max-w-3xl lg:max-w-4xl sm:w-[90%] md:w-[85%] px-2">
        <Collapsible>
          <CollapsibleTrigger asChild>
            <div className="flex items-center justify-between cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 border-l-2 border-red-400">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3 w-3 text-red-500" />
                <span className="text-xs font-medium text-red-600">
                  Schema Error
                </span>
              </div>
              <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="bg-background rounded border border-red-200 p-3 mt-2">
              <div className="space-y-3">
                <Alert
                  variant="destructive"
                  className="border-red-200 bg-red-50"
                >
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle className="text-red-800">
                    Schema Validation Error
                  </AlertTitle>
                  <AlertDescription className="text-red-700">
                    This conversation entry failed to parse correctly. This
                    might indicate a format change or parsing issue.{" "}
                    <a
                      href="https://github.com/d-kimuson/claude-code-viewer/issues"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-red-600 hover:text-red-800 underline underline-offset-4"
                    >
                      Report this issue
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </AlertDescription>
                </Alert>
                <div className="bg-gray-50 border rounded px-3 py-2">
                  <h5 className="text-xs font-medium text-gray-700 mb-2">
                    Raw Content:
                  </h5>
                  <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono text-gray-800">
                    {errorLine}
                  </pre>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  );
};

type ConversationListProps = {
  conversations: (Conversation | ErrorJsonl)[];
  getToolResult: (toolUseId: string) => ToolResultContent | undefined;
};

export const ConversationList: FC<ConversationListProps> = ({
  conversations,
  getToolResult,
}) => {
  // TODO: Consider moving responsePositions to localStorage for persistence
  // and even faster initial loads
  const [responsePositions, setResponsePositions] = useState<Set<number>>(
    new Set(),
  );
  const [lastScannedLength, setLastScannedLength] = useState(0);

  const validConversations = useMemo(
    () =>
      conversations.filter((conversation) => conversation.type !== "x-error"),
    [conversations],
  );
  const { isRootSidechain, getSidechainConversations } =
    useSidechain(validConversations);

  // Incremental scanning: only scan new conversations when array grows
  useEffect(() => {
    if (conversations.length > lastScannedLength) {
      const newPositions = new Set(responsePositions);

      // Only scan the new conversations (efficient!)
      for (let i = lastScannedLength; i < conversations.length; i++) {
        const conv = conversations[i];
        if (conv && conv.type === "assistant") {
          const hasTextContent = conv.message.content.some(
            (content: any) =>
              content.type === "text" && content.text && content.text.trim(),
          );
          if (hasTextContent) {
            newPositions.add(i);
          }
        }
      }

      setResponsePositions(newPositions);
      setLastScannedLength(conversations.length);
    }
  }, [
    conversations.length,
    lastScannedLength,
    responsePositions,
    conversations,
  ]);

  // Group conversations: each user message followed by all responses until the next user message
  // This ensures only one "Full output" section per user prompt
  const groupedConversations = useMemo(() => {
    const groups: (
      | Conversation
      | ErrorJsonl
      | {
          type: "assistant-group";
          conversations: Conversation[];
          isOngoing?: boolean;
        }
      | {
          type: "edit-group";
          conversations: Conversation[];
          isOngoing?: boolean;
          isAfterLastUser?: boolean;
        }
      | {
          type: "user-section";
          userMessage: Conversation;
          workGroups: Array<
            | {
                type: "assistant-group";
                conversations: Conversation[];
                isOngoing?: boolean;
              }
            | {
                type: "edit-group";
                conversations: Conversation[];
                isOngoing?: boolean;
                isAfterLastUser?: boolean;
              }
          >;
          isLast: boolean;
        }
    )[] = [];

    // First pass: Create initial groups (assistant-groups and edit-groups) as before
    const initialGroups: (
      | Conversation
      | ErrorJsonl
      | {
          type: "assistant-group";
          conversations: Conversation[];
          isOngoing?: boolean;
        }
      | {
          type: "edit-group";
          conversations: Conversation[];
          isOngoing?: boolean;
          isAfterLastUser?: boolean;
        }
    )[] = [];

    let currentAssistantGroup: Conversation[] = [];
    let hasSeenUserMessage = false;
    let lastUserIndex = -1;

    // Find the index of the last user message
    for (let i = conversations.length - 1; i >= 0; i--) {
      const conv = conversations[i];
      if (conv && conv.type === "user") {
        lastUserIndex = i;
        break;
      }
    }

    // Find the index of the last REAL user message (for edit group expansion)
    let lastRealUserIndex = -1;
    for (let i = conversations.length - 1; i >= 0; i--) {
      const conv = conversations[i];
      if (conv && conv.type === "user") {
        // Check if this is a real user message or just a tool result
        const isToolResultOnly =
          conv.message &&
          typeof conv.message.content === "object" &&
          Array.isArray(conv.message.content) &&
          conv.message.content.every((c: any) => c.type === "tool_result");

        if (!isToolResultOnly) {
          lastRealUserIndex = i;
          break;
        }
      }
    }

    for (let i = 0; i < conversations.length; i++) {
      const conversation = conversations[i];
      if (!conversation) continue;
      const isAfterLastUser = lastUserIndex >= 0 && i > lastUserIndex;

      if (conversation.type === "x-error") {
        // Flush any pending assistant group only if we have content
        if (currentAssistantGroup.length > 0 && hasSeenUserMessage) {
          initialGroups.push({
            type: "assistant-group",
            conversations: [...currentAssistantGroup],
            isOngoing: isAfterLastUser,
          });
          currentAssistantGroup = [];
          hasSeenUserMessage = false;
        }
        initialGroups.push(conversation);
      } else if (conversation.type === "user") {
        // Check if this is a real user message or just a tool result
        const isToolResultOnly =
          conversation.message &&
          typeof conversation.message.content === "object" &&
          Array.isArray(conversation.message.content) &&
          conversation.message.content.every(
            (c: any) => c.type === "tool_result",
          );

        if (!isToolResultOnly) {
          // Real user message - flush assistant group if we have responses
          if (currentAssistantGroup.length > 0 && hasSeenUserMessage) {
            initialGroups.push({
              type: "assistant-group",
              conversations: [...currentAssistantGroup],
              isOngoing: false,
            });
            currentAssistantGroup = [];
          }
          initialGroups.push(conversation);
          hasSeenUserMessage = true;
        } else {
          // Tool result only - add to current group, don't flush
          currentAssistantGroup.push(conversation);
        }
      } else {
        // Handle assistant, system, summary conversations
        if (conversation.type === "assistant") {
          const hasEditTool = conversation.message.content.some(
            (content: AssistantMessageContent) =>
              typeof content === "object" &&
              "type" in content &&
              content.type === "tool_use" &&
              (content.name === "Edit" || content.name === "MultiEdit"),
          );

          // Use simple Set lookup for final response detection
          const isFinalResponse = responsePositions.has(i);

          if (hasEditTool) {
            // Flush current group if any
            if (currentAssistantGroup.length > 0 && hasSeenUserMessage) {
              initialGroups.push({
                type: "assistant-group",
                conversations: [...currentAssistantGroup],
                isOngoing: isAfterLastUser,
              });
              currentAssistantGroup = [];
            }
            // Add the edit conversation as its own group
            // For edit groups, use lastRealUserIndex to determine expansion
            const isAfterLastRealUser =
              lastRealUserIndex >= 0 && i > lastRealUserIndex;
            initialGroups.push({
              type: "edit-group",
              conversations: [conversation],
              isOngoing: false,
              isAfterLastUser: isAfterLastRealUser,
            });
          } else if (isFinalResponse && hasSeenUserMessage) {
            // Add response to current assistant group
            currentAssistantGroup.push(conversation);
          } else if (hasSeenUserMessage) {
            // Add to current group only if we've seen a user message
            currentAssistantGroup.push(conversation);
          } else {
            // If no user message yet, treat as individual conversation
            initialGroups.push(conversation);
          }
        } else if (hasSeenUserMessage) {
          // Non-assistant conversations (system, summary) go into the group
          currentAssistantGroup.push(conversation);
        } else {
          // If no user message yet, treat as individual conversation
          initialGroups.push(conversation);
        }
      }
    }

    // Flush final assistant group if any and we have seen a user message
    if (currentAssistantGroup.length > 0 && hasSeenUserMessage) {
      const isAfterLastUser =
        lastUserIndex >= 0 && conversations.length > lastUserIndex + 1;
      initialGroups.push({
        type: "assistant-group",
        conversations: [...currentAssistantGroup],
        isOngoing: isAfterLastUser,
      });
    }

    // Second pass: Group assistant-groups and edit-groups under user messages
    let currentUserMessage: Conversation | null = null;
    let currentWorkGroups: Array<
      | {
          type: "assistant-group";
          conversations: Conversation[];
          isOngoing?: boolean;
        }
      | {
          type: "edit-group";
          conversations: Conversation[];
          isOngoing?: boolean;
          isAfterLastUser?: boolean;
        }
    > = [];

    for (let i = 0; i < initialGroups.length; i++) {
      const group = initialGroups[i];

      if (
        group &&
        typeof group === "object" &&
        "type" in group &&
        group.type === "user" &&
        !group.isSidechain
      ) {
        // Check if this is a real user message (not just tool results)
        const isToolResultOnly =
          group.message &&
          typeof group.message.content === "object" &&
          Array.isArray(group.message.content) &&
          group.message.content.every((c: any) => c.type === "tool_result");

        if (!isToolResultOnly) {
          // Flush previous user section if we have one
          if (currentUserMessage && currentWorkGroups.length > 0) {
            groups.push({
              type: "user-section",
              userMessage: currentUserMessage,
              workGroups: [...currentWorkGroups],
              isLast: false,
            });
          }

          // Start new user section
          currentUserMessage = group;
          currentWorkGroups = [];
        } else {
          // Tool result only - add to current work groups as assistant-group if we have a user message
          if (currentUserMessage) {
            currentWorkGroups.push({
              type: "assistant-group",
              conversations: [group],
              isOngoing: false,
            });
          } else {
            // No user message yet, add individually
            groups.push(group);
          }
        }
      } else if (
        group &&
        typeof group === "object" &&
        "type" in group &&
        (group.type === "assistant-group" || group.type === "edit-group")
      ) {
        // Add to current work groups if we have a user message
        if (currentUserMessage) {
          currentWorkGroups.push(group);
        } else {
          // No user message yet, add individually
          groups.push(group);
        }
      } else if (group) {
        // Other types (errors, system messages before first user, etc.)
        groups.push(group);
      }
    }

    // Flush final user section if we have one
    if (currentUserMessage) {
      groups.push({
        type: "user-section",
        userMessage: currentUserMessage,
        workGroups: [...currentWorkGroups],
        isLast: true, // Mark the last user section
      });
    }

    return groups;
  }, [conversations, responsePositions]);

  // Find the last visible message (either standalone edit or final assistant message)
  // const _lastVisibleMessageIndex = useMemo(() => {
  //   for (let i = groupedConversations.length - 1; i >= 0; i--) {
  //     const g = groupedConversations[i];
  //     if (g && g.type !== "assistant-group") {
  //       return i;
  //     }
  //   }
  //   return -1;
  // }, [groupedConversations]);

  // Helper function to generate stable keys for groups
  const getGroupKey = (
    group: (typeof groupedConversations)[0] | undefined,
    index: number,
  ) => {
    if (!group) {
      return `unknown_${index}`;
    }
    if (group.type === "x-error") {
      return `error_${group.line}`;
    }
    if ("conversations" in group && group.conversations.length > 0) {
      const firstConversation = group.conversations[0];
      if (firstConversation && "uuid" in firstConversation) {
        return `${group.type}_${firstConversation.uuid}`;
      }
    }
    // Fallback to index if no stable identifier available
    return `${group.type}_${index}`;
  };

  // Helper function to render assistant groups
  const renderAssistantGroup = (
    group: {
      type: "assistant-group";
      conversations: Conversation[];
      isOngoing?: boolean;
    },
    _groupIndex: number,
  ) => {
    // Extract tool names and determine status from all conversations in the group
    const toolNames = new Set<string>();
    let shouldExpand = false;
    let responseCount = 0;

    // Helper function to enhance tool names (similar to AssistantConversationContent)
    const getEnhancedToolName = (content: any): string => {
      if (content.name === "Bash") {
        const getBashCommandName = (input: unknown): string | null => {
          if (
            input &&
            typeof input === "object" &&
            "command" in input &&
            typeof input.command === "string"
          ) {
            const command = input.command.trim();
            const firstWord = command.split(/\s+/)[0];
            return firstWord || null;
          }
          return null;
        };

        const cmdName = getBashCommandName(content.input);
        return cmdName ? `Bash-${cmdName}` : "Bash";
      }
      return content.name;
    };

    group.conversations.forEach((conversation) => {
      if (conversation.type === "assistant") {
        // Check if this is a response message (has text content)
        const hasTextContent = conversation.message.content.some(
          (content: any) =>
            content.type === "text" && content.text && content.text.trim(),
        );
        if (hasTextContent) {
          responseCount++;
        }

        conversation.message.content.forEach((content) => {
          if (content.type === "tool_use") {
            toolNames.add(getEnhancedToolName(content));
            // Auto-expand the Response group if this is an edit-related tool
            if (content.name === "Edit" || content.name === "MultiEdit") {
              shouldExpand = true;
            }
          }
        });
      }

      // Check for tool result errors in any conversation type
      if (
        "message" in conversation &&
        conversation.message &&
        conversation.message.content
      ) {
        const content = Array.isArray(conversation.message.content)
          ? conversation.message.content
          : [conversation.message.content];

        content.forEach((item) => {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "tool_result"
          ) {
            if ("is_error" in item && item.is_error) {
              // _hasErrors = true;
            }
          }
        });
      }

      // Check for interruption in toolUseResult (from JSONL format)
      if (
        typeof conversation === "object" &&
        "toolUseResult" in conversation &&
        conversation.toolUseResult
      ) {
        if (
          typeof conversation.toolUseResult === "object" &&
          conversation.toolUseResult !== null &&
          "interrupted" in conversation.toolUseResult &&
          conversation.toolUseResult.interrupted
        ) {
          // _hasErrors = true;
        }
      }
    });

    // Render grouped assistant messages in a collapsible
    const assistantContent = (
      <ul className="w-full">
        {group.conversations.map((conversation) => {
          // Check if this conversation is a response (has text content)
          const isResponseConversation =
            conversation.type === "assistant" &&
            conversation.message.content.some(
              (content: any) =>
                content.type === "text" && content.text && content.text.trim(),
            );

          return (
            <li key={getConversationKey(conversation)}>
              <ConversationItem
                conversation={conversation}
                getToolResult={getToolResult}
                isRootSidechain={isRootSidechain}
                getSidechainConversations={getSidechainConversations}
                isResponse={isResponseConversation}
              />
            </li>
          );
        })}
      </ul>
    );

    // For ongoing messages (after last user message), show dot visualization
    const isOngoing = group.isOngoing;

    // Build chronological list of events (tools and responses in order)
    const events: Array<{ type: "tool"; id: string } | { type: "response" }> =
      [];
    const toolUsesWithStatus: Array<{
      id: string;
      hasError: boolean;
      hasResult: boolean;
    }> = [];

    group.conversations.forEach((conversation) => {
      if (conversation.type === "assistant") {
        conversation.message.content.forEach((content) => {
          if (content.type === "tool_use") {
            events.push({ type: "tool", id: content.id });
            toolUsesWithStatus.push({
              id: content.id,
              hasError: false,
              hasResult: false,
            });
          } else if (content.type === "text" && content.text?.trim()) {
            events.push({ type: "response" });
          }
        });
      }
    });

    // Check tool results to determine status of each tool use
    group.conversations.forEach((conversation) => {
      if (
        "message" in conversation &&
        conversation.message &&
        conversation.message.content
      ) {
        const content = Array.isArray(conversation.message.content)
          ? conversation.message.content
          : [conversation.message.content];

        content.forEach((item) => {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "tool_result" &&
            "tool_use_id" in item
          ) {
            const toolUse = toolUsesWithStatus.find(
              (t) => t.id === item.tool_use_id,
            );
            if (toolUse) {
              toolUse.hasResult = true;
              if ("is_error" in item && item.is_error) {
                toolUse.hasError = true;
              }
            }
          }
        });
      }
    });

    // Create dots in chronological order
    const dots = events.slice(0, 15).map((event, i) => {
      if (event.type === "tool") {
        const toolUse = toolUsesWithStatus.find((t) => t.id === event.id);
        let dotColor = "bg-blue-600 dark:bg-blue-400"; // ongoing
        if (toolUse?.hasResult) {
          dotColor = toolUse.hasError
            ? "bg-red-600 dark:bg-red-400"
            : "bg-green-600 dark:bg-green-400";
        }
        return (
          <div
            key={`event-${i}`}
            className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}
          />
        );
      } else {
        // Response
        return (
          <div
            key={`event-${i}`}
            className="w-2 h-2 rounded-full flex-shrink-0 bg-orange-600 dark:bg-orange-400"
          />
        );
      }
    });

    const totalCount = events.length;

    const triggerContent = (
      <div className="flex items-center gap-2">
        <ChevronRight className="h-4 w-4 text-green-600 dark:text-green-400 transition-transform group-data-[state=open]:rotate-90" />
        <div className="flex items-center gap-0.5">{dots}</div>
        <span className="text-sm font-medium text-green-600 dark:text-green-400 ml-1">
          ({totalCount})
        </span>
      </div>
    );

    // Find the last response text in this group for external display
    let lastResponseText = "";
    for (let i = group.conversations.length - 1; i >= 0; i--) {
      const conversation = group.conversations[i];
      if (conversation && conversation.type === "assistant") {
        const textContent = conversation.message.content.find(
          (content: any) => content.type === "text",
        );
        if (
          textContent &&
          "text" in textContent &&
          typeof textContent.text === "string" &&
          textContent.text.trim()
        ) {
          lastResponseText = textContent.text.trim();
          break;
        }
      }
    }

    return (
      <div className="w-full">
        <Collapsible
          defaultOpen={isOngoing ? shouldExpand : false}
          onOpenChange={(_open) => {
            // Track expansion state for this group to hide external response card when expanded
            if (isOngoing && responseCount > 0) {
              // This is the last group with responses - we need to manage external card visibility
              // The external card will be hidden when expanded via CSS/conditional rendering
            }
          }}
        >
          <CollapsibleTrigger asChild>
            <div className="flex items-center cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 mb-2">
              {triggerContent}
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="bg-background rounded border p-3 mt-2">
              {assistantContent}
            </div>
          </CollapsibleContent>

          {/* External response card - only shown for the last assistant group with responses when collapsed */}
          {responseCount > 0 && lastResponseText && isOngoing && (
            <div className="mt-2 p-3 bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 rounded group-data-[state=open]:hidden">
              <div className="text-sm font-medium text-orange-800 dark:text-orange-200 mb-2">
                Response:
              </div>
              <MarkdownContent
                className="w-full text-sm text-orange-700 dark:text-orange-300 [&_p]:mb-1 [&_h1]:mb-2 [&_h1]:mt-2 [&_h2]:mb-2 [&_h2]:mt-2 [&_h3]:mb-1 [&_h3]:mt-2 [&_h4]:mb-1 [&_h4]:mt-1 [&_h5]:mb-1 [&_h5]:mt-1 [&_h6]:mb-1 [&_h6]:mt-1 [&_ul]:mb-2 [&_ol]:mb-2 [&_blockquote]:my-2 [&_pre]:my-2"
                content={lastResponseText}
              />
            </div>
          )}
        </Collapsible>
      </div>
    );
  };

  // Helper function to render edit groups
  const renderEditGroup = (
    group: {
      type: "edit-group";
      conversations: Conversation[];
      isOngoing?: boolean;
      isAfterLastUser?: boolean;
    },
    _groupIndex: number,
  ) => {
    // Check for errors in edit tool results
    const hasErrors = false;
    group.conversations.forEach((conversation) => {
      if (
        "message" in conversation &&
        conversation.message &&
        conversation.message.content
      ) {
        const content = Array.isArray(conversation.message.content)
          ? conversation.message.content
          : [conversation.message.content];

        content.forEach((item) => {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "tool_result"
          ) {
            if ("is_error" in item && item.is_error) {
              // _hasErrors = true;
            }
          }
        });
      }
    });

    // Render edit tool in its own accordion
    const assistantContent = (
      <ul className="w-full">
        {group.conversations.map((conversation) => (
          <li key={getConversationKey(conversation)}>
            <ConversationItem
              conversation={conversation}
              getToolResult={getToolResult}
              isRootSidechain={isRootSidechain}
              getSidechainConversations={getSidechainConversations}
              isInEditGroup={true}
            />
          </li>
        ))}
      </ul>
    );

    return (
      <div className="w-full">
        <Collapsible defaultOpen={true}>
          <CollapsibleTrigger asChild>
            <div className="flex items-center cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 mb-2">
              <div className="flex items-center gap-2">
                <ChevronRight className="h-4 w-4 text-green-600 dark:text-green-400 transition-transform group-data-[state=open]:rotate-90" />
                <StatusDot
                  status={hasErrors ? "error" : "success"}
                  className=""
                />
                <h4 className="text-sm font-medium text-muted-foreground">
                  Edit
                </h4>
              </div>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="bg-background rounded border p-3 mt-2">
              {assistantContent}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  };

  return (
    <ul>
      {groupedConversations.flatMap((group, groupIndex) => {
        if (group.type === "x-error") {
          return (
            <SchemaErrorDisplay
              key={`error_${group.line}`}
              errorLine={group.line}
            />
          );
        }

        if (group.type === "user-section") {
          // Render user section as accordion (or not if it's the last one)
          const userMessage = group.userMessage;
          const workGroups = group.workGroups;
          const isLast = group.isLast;

          // Render user message
          const userContent = (
            <ConversationItem
              conversation={userMessage}
              getToolResult={getToolResult}
              isRootSidechain={isRootSidechain}
              getSidechainConversations={getSidechainConversations}
            />
          );

          // Render work groups
          const workContent = workGroups.map((workGroup, workIndex) => {
            if (workGroup.type === "assistant-group") {
              return renderAssistantGroup(workGroup, workIndex);
            } else if (workGroup.type === "edit-group") {
              return renderEditGroup(workGroup, workIndex);
            }
            return null;
          });

          if (isLast) {
            // Last user section - render without accordion (no chevron)
            return [
              <li
                className="w-full flex justify-start"
                key={`user-section-${groupIndex}`}
              >
                <div className="w-full">{userContent}</div>
              </li>,
              ...workContent.map((content, workIndex) => (
                <li
                  className="w-full flex justify-start"
                  key={`user-section-${groupIndex}-work-${workIndex}`}
                >
                  <div className="w-full">{content}</div>
                </li>
              )),
            ];
          } else {
            // Previous user section - render as collapsed accordion
            return (
              <li
                className="w-full flex justify-start"
                key={`user-section-${groupIndex}`}
              >
                <div className="w-full">
                  <Collapsible defaultOpen={false}>
                    <CollapsibleTrigger asChild>
                      <div className="flex items-center cursor-pointer hover:bg-muted/50 rounded py-0.5 px-2 -mx-2 group">
                        <ChevronRight className="h-4 w-4 text-blue-600 dark:text-blue-400 transition-transform group-data-[state=open]:rotate-90" />
                        <div className="ml-2 flex-1">{userContent}</div>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="bg-background rounded border p-3 mt-2">
                        <ul className="w-full">
                          {workContent.map((content, workIndex) => (
                            <li key={`work-${workIndex}`}>{content}</li>
                          ))}
                        </ul>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </li>
            );
          }
        }

        if (group.type === "assistant-group") {
          return (
            <li
              className="w-full flex justify-start"
              key={`assistant-group-${getGroupKey(group, groupIndex)}`}
            >
              {renderAssistantGroup(group, groupIndex)}
            </li>
          );
        }

        if (group.type === "edit-group") {
          return (
            <li
              className="w-full flex justify-start"
              key={`edit-group-${getGroupKey(group, groupIndex)}`}
            >
              {renderEditGroup(group, groupIndex)}
            </li>
          );
        }

        // Handle individual non-assistant conversations
        const conversation = group as Conversation;
        const elm = (
          <ConversationItem
            key={getConversationKey(conversation)}
            conversation={conversation}
            getToolResult={getToolResult}
            isRootSidechain={isRootSidechain}
            getSidechainConversations={getSidechainConversations}
          />
        );

        return [
          <li
            className="w-full flex justify-start"
            key={getConversationKey(conversation)}
          >
            <div className="w-full">{elm}</div>
          </li>,
        ];
      })}
    </ul>
  );
};
