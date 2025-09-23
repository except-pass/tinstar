import { ChevronRight, Lightbulb, Map } from "lucide-react";
import Image from "next/image";
import parseGitDiff from "parse-git-diff";
import type { FC } from "react";
import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
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
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
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
  isResponse?: boolean;
  isInEditGroup?: boolean;
}> = ({ content, getToolResult, isResponse = false, isInEditGroup = false }) => {
  const { openInEditor } = useOpenInEditor();
  if (content.type === "text") {
    return (
      <div className={`w-full mx-1 sm:mx-2 my-2 ${isResponse ? "p-3 bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 rounded" : ""}`}>
        {isResponse && (
          <div className="text-sm font-medium text-orange-800 dark:text-orange-200 mb-2">
            Response:
          </div>
        )}
        <MarkdownContent
          className={`w-full text-sm [&_p]:mb-1 [&_h1]:mb-2 [&_h1]:mt-2 [&_h2]:mb-2 [&_h2]:mt-2 [&_h3]:mb-1 [&_h3]:mt-2 [&_h4]:mb-1 [&_h4]:mt-1 [&_h5]:mb-1 [&_h5]:mt-1 [&_h6]:mb-1 [&_h6]:mt-1 [&_ul]:mb-2 [&_ol]:mb-2 [&_blockquote]:my-2 [&_pre]:my-2 ${isResponse ? "text-orange-700 dark:text-orange-300" : ""}`}
          content={content.text}
        />
      </div>
    );
  }

  if (content.type === "thinking") {
    return (
      <Card className="bg-muted/50 border-dashed gap-2 py-3 mb-2">
        <Collapsible>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/80 rounded-t-lg transition-colors py-0 px-4 group">
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

    // Simplified rendering for edit tools in edit groups
    if (isEditTool && isInEditGroup && filePath) {
      const handleOpenInEditor = async () => {
        if (filePath) {
          try {
            const result = await openInEditor(filePath);
            if (!result.success) {
              console.error(
                "Failed to open file in editor:",
                result.error,
              );
            }
          } catch (error) {
            console.error("Error opening file in editor:", error);
          }
        }
      };

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
        <div className="mb-2">
          <DiffViewer
            fileDiff={fileDiff}
            onEditFile={handleOpenInEditor}
            showEditButton={true}
          />
        </div>
      );
    }

    // Special handling for ExitPlanMode - display the plan content
    if (content.name === "ExitPlanMode") {
      const input = content.input as { plan?: string };
      const plan = input?.plan || "No plan details available";
      return (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 mb-2">
          <CardHeader className="py-3 px-4">
            <div className="flex items-center gap-2">
              <Map className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <CardTitle className="text-sm font-medium">Plan Ready</CardTitle>
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
              >
                ExitPlanMode
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="py-3 px-4">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownContent content={plan} />
            </div>
          </CardContent>
        </Card>
      );
    }


    // State for button-style toggles
    const [showInputs, setShowInputs] = useState(false);
    const [showOutputs, setShowOutputs] = useState(false);

    return (
      <div className="mb-2">
        {/* Compact header with tool badge and toggle buttons */}
        <div className="flex items-center gap-2 mb-2">
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

          <button
            onClick={() => setShowInputs(!showInputs)}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              showInputs
                ? "bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/50 dark:border-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                : "bg-muted border-muted-foreground/20 text-muted-foreground hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 dark:hover:bg-blue-900/20 dark:hover:border-blue-800 dark:hover:text-blue-400"
            }`}
          >
            Inputs
          </button>

          {toolResult && (
            <button
              onClick={() => setShowOutputs(!showOutputs)}
              className={`px-2 py-1 text-xs rounded border transition-colors ${
                showOutputs
                  ? "bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/50 dark:border-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                  : "bg-muted border-muted-foreground/20 text-muted-foreground hover:bg-blue-50 hover:border-blue-200 hover:text-blue-600 dark:hover:bg-blue-900/20 dark:hover:border-blue-800 dark:hover:text-blue-400"
              }`}
            >
              Outputs
            </button>
          )}
        </div>

        {/* Conditionally shown sections */}
        {showInputs && (
          <div className="mb-2">
            <SyntaxHighlighter
              style={oneLight}
              language="json"
              PreTag="div"
              className="text-xs"
            >
              {JSON.stringify(content.input, null, 2)}
            </SyntaxHighlighter>
          </div>
        )}

        {showOutputs && toolResult && (
          <div className="bg-background rounded border p-2">
            {(() => {
              const c = toolResult.content;
              // Handle string content
              if (typeof c === "string") {
                const trimmed = c.trim();
                return (
                  <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">
                    {trimmed.length === 0 ? "<no output>" : c}
                  </pre>
                );
              }
              // Handle array content
              if (Array.isArray(c) && c.length === 0) {
                return (
                  <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">{`<no output>`}</pre>
                );
              }
              return c.map((item) => {
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
                  const textTrimmed = item.text.trim();
                  return (
                    <pre
                      key={item.text}
                      className="text-xs overflow-x-auto whitespace-pre-wrap break-words"
                    >
                      {textTrimmed.length === 0 ? "<no output>" : item.text}
                    </pre>
                  );
                }
                item satisfies never;
                throw new Error("Unexpected tool result content type");
              });
            })()}
          </div>
        )}
      </div>
    );
  }

  if (content.type === "tool_result") {
    return null;
  }

  return null;
};
