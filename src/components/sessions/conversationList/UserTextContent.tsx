import { Terminal } from "lucide-react";
import type { FC } from "react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  extractCleanCommand,
  getCommandName,
  isSlashCommandMessage,
} from "@/lib/utils/slashCommandFilter";
import { parseCommandXml } from "@/server/service/parseCommandXml";

export const UserTextContent: FC<{ text: string; id?: string }> = ({
  text,
  id,
}) => {
  // Check for slash command messages from command palette first
  if (isSlashCommandMessage(text)) {
    const cleanCommand = extractCleanCommand(text);
    const commandName = getCommandName(cleanCommand);

    return (
      <Card
        className="border-purple-200 bg-purple-50/50 dark:border-purple-800 dark:bg-purple-950/20 gap-2 py-2 mb-1"
        id={id}
      >
        <CardHeader className="py-0 px-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            <CardTitle className="text-sm font-medium">
              Command Palette
            </CardTitle>
            <Badge
              variant="outline"
              className="border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-300"
            >
              {commandName}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="py-0 px-4">
          <code className="text-sm font-mono text-purple-800 dark:text-purple-200">
            {cleanCommand}
          </code>
        </CardContent>
      </Card>
    );
  }

  const parsed = parseCommandXml(text);

  if (parsed.kind === "command") {
    return (
      <Card
        className="border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20 gap-2 py-2 mb-1"
        id={id}
      >
        <CardHeader className="py-0 px-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-green-600 dark:text-green-400" />
            <CardTitle className="text-sm font-medium">
              Claude Code Command
            </CardTitle>
            <Badge
              variant="outline"
              className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-300"
            >
              {parsed.commandName}
            </Badge>
          </div>
        </CardHeader>
        {parsed.commandArgs || parsed.commandMessage ? (
          <CardContent className="py-0 px-4">
            <div className="space-y-2">
              <div>
                {parsed.commandArgs && (
                  <>
                    <span className="text-xs font-medium text-muted-foreground">
                      Arguments:
                    </span>
                    <div className="bg-background rounded border p-2 mt-1">
                      <code className="text-xs whitespace-pre-line break-all">
                        {parsed.commandArgs}
                      </code>
                    </div>
                  </>
                )}
                {parsed.commandMessage && (
                  <>
                    <span className="text-xs font-medium text-muted-foreground">
                      Message:
                    </span>
                    <div className="bg-background rounded border p-2 mt-1">
                      <code className="text-xs whitespace-pre-line break-all">
                        {parsed.commandMessage}
                      </code>
                    </div>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        ) : null}
      </Card>
    );
  }

  if (parsed.kind === "local-command") {
    return (
      <Card className="border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20 gap-2 py-2 mb-1">
        <CardHeader className="py-0 px-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-green-600 dark:text-green-400" />
            <CardTitle className="text-sm font-medium">Local Command</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="py-0 px-4">
          <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">
            {parsed.stdout}
          </pre>
        </CardContent>
      </Card>
    );
  }

  return (
    <MarkdownContent
      className="w-full px-2 py-1 mb-1 border-2 border-blue-200 dark:border-blue-800 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-sm [&_p]:mb-1 [&_h1]:mb-2 [&_h1]:mt-2 [&_h2]:mb-2 [&_h2]:mt-2 [&_h3]:mb-1 [&_h3]:mt-2 [&_h4]:mb-1 [&_h4]:mt-1 [&_h5]:mb-1 [&_h5]:mt-1 [&_h6]:mb-1 [&_h6]:mt-1 [&_ul]:mb-2 [&_ol]:mb-2 [&_blockquote]:my-2 [&_pre]:my-2"
      content={parsed.content}
    />
  );
};
