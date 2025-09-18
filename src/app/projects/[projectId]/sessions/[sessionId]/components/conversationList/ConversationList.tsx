"use client";

import { AlertTriangle, ChevronRight, ExternalLink } from "lucide-react";
import { type FC, useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { StatusDot } from "@/components/ui/status-dot";
import type { Conversation } from "@/lib/conversation-schema";
import type { ToolResultContent } from "@/lib/conversation-schema/content/ToolResultContentSchema";
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
  const validConversations = useMemo(
    () =>
      conversations.filter((conversation) => conversation.type !== "x-error"),
    [conversations],
  );
  const { isRootSidechain, getSidechainConversations } =
    useSidechain(validConversations);

  // Group conversations: each user message followed by all responses until the next user message
  // This ensures only one "Full output" section per user prompt
  const groupedConversations = useMemo(() => {
    const groups: (
      | Conversation
      | ErrorJsonl
      | { type: "assistant-group"; conversations: Conversation[]; isOngoing?: boolean }
      | { type: "response-group"; conversations: Conversation[]; isOngoing?: boolean; isTrulyFinal?: boolean; isAfterLastUser?: boolean }
      | { type: "edit-group"; conversations: Conversation[]; isOngoing?: boolean; isAfterLastUser?: boolean }
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
        const isToolResultOnly = conversation.message &&
          (typeof conversation.message.content === "object") &&
          Array.isArray(conversation.message.content) &&
          conversation.message.content.every((c: any) => c.type === "tool_result");

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
            (content: any) =>
              content.type === "tool_use" &&
              (content.name === "Edit" || content.name === "MultiEdit")
          );

          // Check if this is the final response message (has text content and is the last assistant message before next user)
          const hasTextContent = conversation.message.content.some(
            (content: any) => content.type === "text"
          );

          // Check if this is the last assistant message before the next user message
          let isLastAssistantBeforeUser = false;
          for (let j = i + 1; j < conversations.length; j++) {
            const nextConv = conversations[j];
            if (!nextConv) continue;

            // Check if it's a real user message (not just tool result)
            if (nextConv.type === "user") {
              const isRealUserMessage = !(
                nextConv.message &&
                typeof nextConv.message.content === "object" &&
                Array.isArray(nextConv.message.content) &&
                nextConv.message.content.every((c: any) => c.type === "tool_result")
              );
              if (isRealUserMessage) {
                isLastAssistantBeforeUser = true;
                break;
              }
            }

            // If we hit another assistant message with text, this isn't the last one
            if (nextConv.type === "assistant") {
              const hasText = nextConv.message.content.some((c: any) => c.type === "text");
              if (hasText) {
                break;
              }
            }
          }

          // Also check if it's the very last assistant message in the conversation
          const isVeryLastAssistant = i === conversations.length - 1 ||
            !conversations.slice(i + 1).some(c => c && c.type === "assistant" &&
              c.message.content.some((content: any) => content.type === "text"));

          const isFinalResponse = hasTextContent && (isLastAssistantBeforeUser || isVeryLastAssistant);

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
            groups.push({
              type: "edit-group",
              conversations: [conversation],
              isOngoing: false,
              isAfterLastUser: isAfterLastUser,
            });
          } else if (isFinalResponse && hasSeenUserMessage) {
            // This is the final response message - flush current group WITHOUT this message
            if (currentAssistantGroup.length > 0) {
              groups.push({
                type: "assistant-group",
                conversations: [...currentAssistantGroup],
                isOngoing: isAfterLastUser,
              });
              currentAssistantGroup = [];
            }

            // Check if this is truly the final message (no user messages after it)
            const isTrulyFinal = !conversations.slice(i + 1).some(c => c && c.type === "user" && !(
              c.message &&
              (typeof c.message.content === "object") &&
              Array.isArray(c.message.content) &&
              c.message.content.every((content: any) => content.type === "tool_result")
            ));

            // Add response as its own separate group
            groups.push({
              type: "response-group",
              conversations: [conversation],
              isOngoing: false,
              isTrulyFinal: isTrulyFinal,
              isAfterLastUser: isAfterLastUser,
            });
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
      const isAfterLastUser = lastUserIndex >= 0 && conversations.length > lastUserIndex + 1;
      groups.push({
        type: "assistant-group",
        conversations: [...currentAssistantGroup],
        isOngoing: isAfterLastUser,
      });
    }

    return groups;
  }, [conversations]);


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
          // let _hasToolUse = false;
          // let _hasErrors = false;

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
              conversation.message.content.forEach((content) => {
                if (content.type === "tool_use") {
                  // _hasToolUse = true;
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
              {group.conversations.map((conversation) => (
                <li key={getConversationKey(conversation)}>
                  <ConversationItem
                    conversation={conversation}
                    getToolResult={getToolResult}
                    isRootSidechain={isRootSidechain}
                    getSidechainConversations={getSidechainConversations}
                  />
                </li>
              ))}
            </ul>
          );

          // For ongoing messages (after last user message), show dot visualization
          const isOngoing = group.isOngoing;
          // const _messageCount = group.conversations.length;


          // Extract tool uses and their statuses for dot visualization
          const toolUsesWithStatus: Array<{ id: string; hasError: boolean; hasResult: boolean }> = [];

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
            if ("message" in conversation && conversation.message && conversation.message.content) {
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
                  const toolUse = toolUsesWithStatus.find(t => t.id === item.tool_use_id);
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

          // Create colored dots based on tool status
          const dots = toolUsesWithStatus.slice(0, 10).map((toolUse, i) => {
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

            return (
              <div
                key={i}
                className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}
              />
            );
          });

          const toolUseCount = toolUsesWithStatus.length;

          const triggerContent = (
            <div className="flex items-center gap-2">
              <ChevronRight className="h-4 w-4 text-green-600 dark:text-green-400 transition-transform group-data-[state=open]:rotate-90" />
              <div className="flex items-center gap-0.5">
                {dots}
              </div>
              <span className="text-sm font-medium text-green-600 dark:text-green-400 ml-1">
                ({toolUseCount})
              </span>
            </div>
          );

          return (
            <li
              className="w-full flex justify-start"
              key={`assistant-group-${groupIndex}`}
            >
              <div className="w-full">
                <Collapsible defaultOpen={isOngoing ? shouldExpand : false}>
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
                </Collapsible>
              </div>
            </li>
          );
        }

        if (group.type === "response-group") {
          // Render response in its own accordion
          const assistantContent = (
            <ul className="w-full">
              {group.conversations.map((conversation) => (
                <li key={getConversationKey(conversation)}>
                  <ConversationItem
                    conversation={conversation}
                    getToolResult={getToolResult}
                    isRootSidechain={isRootSidechain}
                    getSidechainConversations={getSidechainConversations}
                  />
                </li>
              ))}
            </ul>
          );

          return (
            <li
              className="w-full flex justify-start"
              key={`response-group-${groupIndex}`}
            >
              <div className="w-full">
                <Collapsible defaultOpen={group.isTrulyFinal && group.isAfterLastUser}>
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 mb-2">
                      <div className="flex items-center gap-2">
                        <ChevronRight className="h-4 w-4 text-orange-600 dark:text-orange-400 transition-transform group-data-[state=open]:rotate-90" />
                        <h4 className="text-sm font-medium text-orange-600 dark:text-orange-400">
                          Response
                        </h4>
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="bg-orange-50 dark:bg-orange-950/30 rounded border-2 border-orange-200 dark:border-orange-800 p-3 mt-2">
                      {assistantContent}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </li>
          );
        }

        if (group.type === "edit-group") {
          // Check for errors in edit tool results
          let hasErrors = false;
          group.conversations.forEach((conversation) => {
            if ("message" in conversation && conversation.message && conversation.message.content) {
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
                  />
                </li>
              ))}
            </ul>
          );

          return (
            <li
              className="w-full flex justify-start"
              key={`edit-group-${groupIndex}`}
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
            <div className="w-full">
              {elm}
            </div>
          </li>,
        ];
      })}
    </ul>
  );
};
