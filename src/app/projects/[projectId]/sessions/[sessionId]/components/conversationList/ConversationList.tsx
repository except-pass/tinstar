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
import type { UserMessageContent } from "@/lib/conversation-schema/message/UserMessageSchema";
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
            (content: any) => content.type === "text" && content.text && content.text.trim(),
          );
          if (hasTextContent) {
            newPositions.add(i);
          }
        }
      }

      setResponsePositions(newPositions);
      setLastScannedLength(conversations.length);
    }
  }, [conversations.length, lastScannedLength, responsePositions]);


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
          conv.message.content.every(
            (c: any) => c.type === "tool_result",
          );

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
          groups.push({
            type: "assistant-group",
            conversations: [...currentAssistantGroup],
            isOngoing: isAfterLastUser,
          });
          currentAssistantGroup = [];
          hasSeenUserMessage = false;
        }
        groups.push(conversation);
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
            groups.push({
              type: "assistant-group",
              conversations: [...currentAssistantGroup],
              isOngoing: false,
            });
            currentAssistantGroup = [];
          }
          groups.push(conversation);
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
              groups.push({
                type: "assistant-group",
                conversations: [...currentAssistantGroup],
                isOngoing: isAfterLastUser,
              });
              currentAssistantGroup = [];
            }
            // Add the edit conversation as its own group
            // For edit groups, use lastRealUserIndex to determine expansion
            const isAfterLastRealUser = lastRealUserIndex >= 0 && i > lastRealUserIndex;
            groups.push({
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
            groups.push(conversation);
          }
        } else if (hasSeenUserMessage) {
          // Non-assistant conversations (system, summary) go into the group
          currentAssistantGroup.push(conversation);
        } else {
          // If no user message yet, treat as individual conversation
          groups.push(conversation);
        }
      }
    }

    // Flush final assistant group if any and we have seen a user message
    if (currentAssistantGroup.length > 0 && hasSeenUserMessage) {
      const isAfterLastUser =
        lastUserIndex >= 0 && conversations.length > lastUserIndex + 1;
      groups.push({
        type: "assistant-group",
        conversations: [...currentAssistantGroup],
        isOngoing: isAfterLastUser,
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
    group: (typeof groupedConversations)[0],
    index: number,
  ) => {
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

        if (group.type === "assistant-group") {
          // Extract tool names and determine status from all conversations in the group
          const toolNames = new Set<string>();
          let shouldExpand = false;
          let responseCount = 0;
          // let _hasToolUse = false;
          // let _hasErrors = false;

          // Helper function to enhance tool names (similar to AssistantConversationContent)
          const getEnhancedToolName = (
            content: AssistantMessageContent,
          ): string => {
            if (
              typeof content === "object" &&
              "name" in content &&
              content.name === "Bash"
            ) {
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
            return typeof content === "object" && "name" in content
              ? content.name
              : "Unknown Tool";
          };

          group.conversations.forEach((conversation) => {
            if (conversation.type === "assistant") {
              // Check if this is a response message (has text content)
              const hasTextContent = conversation.message.content.some(
                (content: any) => content.type === "text" && content.text && content.text.trim()
              );
              if (hasTextContent) {
                responseCount++;
              }

              conversation.message.content.forEach((content) => {
                if (content.type === "tool_use") {
                  // _hasToolUse = true;
                  toolNames.add(getEnhancedToolName(content));
                  // Auto-expand the Response group if this is an edit-related tool
                  if (
                    typeof content === "object" &&
                    "name" in content &&
                    (content.name === "Edit" || content.name === "MultiEdit")
                  ) {
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
                const isResponseConversation = conversation.type === "assistant" &&
                  conversation.message.content.some(
                    (content: any) => content.type === "text" && content.text && content.text.trim()
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
          // const _messageCount = group.conversations.length;

          // Extract tool uses and their statuses for dot visualization
          const toolUsesWithStatus: Array<{
            id: string;
            hasError: boolean;
            hasResult: boolean;
          }> = [];

          group.conversations.forEach((conversation) => {
            if (conversation.type === "assistant") {
              conversation.message.content.forEach((content) => {
                if (content.type === "tool_use") {
                  toolUsesWithStatus.push({
                    id: content.id,
                    hasError: false,
                    hasResult: false,
                  });
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

          // Create colored dots based on tool status and add orange dots for responses
          const dots = [];

          // Add dots for tool uses
          toolUsesWithStatus.slice(0, 10).forEach((toolUse, i) => {
            let dotColor;
            if (!toolUse.hasResult) {
              // No result yet - blue (ongoing)
              dotColor = "bg-blue-600 dark:bg-blue-400";
            } else if (toolUse.hasError) {
              // Error - red
              dotColor = "bg-red-600 dark:bg-red-400";
            } else {
              // Success - green
              dotColor = "bg-green-600 dark:bg-green-400";
            }

            dots.push(
              <div
                key={`tool-${i}`}
                className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}
              />
            );
          });

          // Add orange dots for responses
          for (let i = 0; i < responseCount; i++) {
            dots.push(
              <div
                key={`response-${i}`}
                className="w-2 h-2 rounded-full flex-shrink-0 bg-orange-600 dark:bg-orange-400"
              />
            );
          }

          const toolUseCount = toolUsesWithStatus.length;
          const totalCount = toolUseCount + responseCount;

          const triggerContent = (
            <div
              key={`trigger-content-${getGroupKey(group, groupIndex)}`}
              className="flex items-center gap-2"
            >
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
                (content: any) => content.type === "text"
              );
              if (textContent && textContent.type === "text" && typeof textContent.text === "string" && textContent.text.trim()) {
                lastResponseText = textContent.text.trim();
                break;
              }
            }
          }

          return (
            <li
              className="w-full flex justify-start"
              key={`assistant-group-${getGroupKey(group, groupIndex)}`}
            >
              <div className="w-full">
                <Collapsible
                  defaultOpen={isOngoing ? shouldExpand : false}
                  onOpenChange={() => {
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
            </li>
          );
        }


        if (group.type === "edit-group") {
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
            <ul
              key={`edit-content-${getGroupKey(group, groupIndex)}`}
              className="w-full"
            >
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
            <li
              className="w-full flex justify-start"
              key={`edit-group-${getGroupKey(group, groupIndex)}`}
            >
              <div className="w-full">
                <Collapsible defaultOpen={group.isAfterLastUser}>
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
