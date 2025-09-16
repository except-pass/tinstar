import { ChevronRight, Lightbulb, Settings } from "lucide-react";
import Image from "next/image";
import parseGitDiff from "parse-git-diff";
import type { FC } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ToolResultContent } from "@/lib/conversation-schema/content/ToolResultContentSchema";
import type { AssistantMessageContent } from "@/lib/conversation-schema/message/AssistantMessageSchema";
import {
  generateMultiEditDiff,
  generateSyntheticGitDiff,
} from "@/lib/synthetic-diff";
import { MarkdownContent } from "../../../../../../components/MarkdownContent";
import { DiffViewer } from "../diffModal/DiffViewer";
import type { FileDiff } from "../diffModal/types";

/**
 * Convert synthetic git diff to FileDiff format for DiffViewer
 */
function convertSyntheticDiffToFileDiff(
  syntheticDiff: string,
  filePath: string,
): FileDiff | null {
  try {
    const parsed = parseGitDiff(syntheticDiff);

    if (parsed.files.length === 0) {
      return null;
    }

    const file = parsed.files[0];
    if (!file) {
      return null;
    }

    // Convert to FileDiff format
    const fileDiff: FileDiff = {
      filename: filePath,
      oldFilename: undefined,
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      isBinary: false,
      linesAdded: 0,
      linesDeleted: 0,
      hunks: [],
    };

    // Convert chunks to hunks
    for (const chunk of file.chunks) {
      if (chunk.type !== "Chunk") continue;

      const lines = chunk.changes.map((change) => {
        switch (change.type) {
          case "AddedLine":
            fileDiff.linesAdded++;
            return {
              type: "added" as const,
              content: change.content,
              newLineNumber: change.lineAfter,
            };
          case "DeletedLine":
            fileDiff.linesDeleted++;
            return {
              type: "deleted" as const,
              content: change.content,
              oldLineNumber: change.lineBefore,
            };
          case "UnchangedLine":
            return {
              type: "unchanged" as const,
              content: change.content,
              oldLineNumber: change.lineBefore,
              newLineNumber: change.lineAfter,
            };
          default:
            return {
              type: "unchanged" as const,
              content: change.content,
            };
        }
      });

      fileDiff.hunks.push({
        oldStart: chunk.fromFileRange.start,
        newStart: chunk.toFileRange.start,
        lines,
      });
    }

    return fileDiff;
  } catch (error) {
    console.error("Failed to parse synthetic diff:", error);
    return null;
  }
}

/**
 * Extract the first command word from Bash tool input parameters
 */
function getBashCommandName(input: unknown): string | null {
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
}

export const AssistantConversationContent: FC<{
  content: AssistantMessageContent;
  getToolResult: (toolUseId: string) => ToolResultContent | undefined;
}> = ({ content, getToolResult }) => {
  if (content.type === "text") {
    return (
      <div className="w-full mx-1 sm:mx-2 my-4 sm:my-6">
        <MarkdownContent content={content.text} />
      </div>
    );
  }

  if (content.type === "thinking") {
    return (
      <Card className="bg-muted/50 border-dashed gap-2 py-3 mb-2">
        <Collapsible>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/80 rounded-t-lg transition-colors py-0 px-4">
              <div className="flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm font-medium">Thinking</CardTitle>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="py-0 px-4">
              <div className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
                {content.thinking}
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  }

  if (content.type === "tool_use") {
    const toolResult = getToolResult(content.id);

    // Check if this is an Edit or MultiEdit tool and extract file_path
    const isEditTool = content.name === "Edit" || content.name === "MultiEdit";
    const filePath =
      isEditTool &&
      content.input &&
      typeof content.input === "object" &&
      "file_path" in content.input
        ? (content.input as { file_path: string }).file_path
        : null;

    const handleOpenInCursor = async () => {
      if (filePath) {
        try {
          // Execute cursor command as child process
          const response = await fetch("/api/cursor-open", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ filePath }),
          });

          if (!response.ok) {
            console.error(
              "Failed to open file in Cursor:",
              await response.text(),
            );
          }
        } catch (error) {
          console.error("Error opening file in Cursor:", error);
        }
      }
    };

    return (
      <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 gap-2 py-3 mb-2">
        <CardHeader className="py-0 px-4">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <CardTitle className="text-sm font-medium">Tool Use</CardTitle>
            <Badge
              variant="outline"
              className="border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300"
            >
              {content.name === "Bash"
                ? (() => {
                    const cmdName = getBashCommandName(content.input);
                    return cmdName ? `Bash-${cmdName}` : "Bash";
                  })()
                : content.name}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            Tool execution with ID: {content.id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 py-0 px-4">
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="flex items-center justify-between cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 w-full bg-transparent border-none">
              <h4 className="text-xs font-medium text-muted-foreground">
                Input Parameters
              </h4>
              <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SyntaxHighlighter
                style={oneLight}
                language="json"
                PreTag="div"
                className="text-xs"
              >
                {JSON.stringify(content.input, null, 2)}
              </SyntaxHighlighter>
            </CollapsibleContent>
          </Collapsible>

          {/* File Diff section for Edit/MultiEdit tools */}
          {isEditTool &&
            filePath &&
            (() => {
              let syntheticDiff: string;

              if (
                content.name === "MultiEdit" &&
                content.input &&
                typeof content.input === "object" &&
                "edits" in content.input
              ) {
                // Handle MultiEdit with multiple edits
                const edits = (content.input as any).edits as Array<{
                  old_string: string;
                  new_string: string;
                }>;
                syntheticDiff = generateMultiEditDiff(filePath, edits);
              } else if (
                content.input &&
                typeof content.input === "object" &&
                "old_string" in content.input &&
                "new_string" in content.input
              ) {
                // Handle single Edit
                const { old_string, new_string } = content.input as {
                  old_string: string;
                  new_string: string;
                };
                syntheticDiff = generateSyntheticGitDiff(
                  filePath,
                  old_string,
                  new_string,
                );
              } else {
                return null;
              }

              const fileDiff = convertSyntheticDiffToFileDiff(
                syntheticDiff,
                filePath,
              );

              if (!fileDiff) {
                return null;
              }

              return (
                <Collapsible defaultOpen={true}>
                  <CollapsibleTrigger className="flex items-center justify-between cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 w-full bg-transparent border-none">
                    <h4 className="text-xs font-medium text-muted-foreground">
                      File Diff
                    </h4>
                    <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2">
                      <DiffViewer
                        fileDiff={fileDiff}
                        onEditFile={handleOpenInCursor}
                        showEditButton={true}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })()}

          {toolResult && (
            <Collapsible defaultOpen={false}>
              <CollapsibleTrigger className="flex items-center justify-between cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2 w-full bg-transparent border-none">
                <h4 className="text-xs font-medium text-muted-foreground">
                  Tool Result
                </h4>
                <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="bg-background rounded border p-2 mt-1">
                  {typeof toolResult.content === "string" ? (
                    <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">
                      {toolResult.content}
                    </pre>
                  ) : (
                    toolResult.content.map((item) => {
                      if (item.type === "image") {
                        return (
                          <Image
                            key={item.source.data}
                            src={`data:${item.source.media_type};base64,${item.source.data}`}
                            alt="Tool Result"
                          />
                        );
                      }
                      if (item.type === "text") {
                        return (
                          <pre
                            key={item.text}
                            className="text-xs overflow-x-auto whitespace-pre-wrap break-words"
                          >
                            {item.text}
                          </pre>
                        );
                      }
                      item satisfies never;
                      throw new Error("Unexpected tool result content type");
                    })
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>
    );
  }

  if (content.type === "tool_result") {
    return null;
  }

  return null;
};
