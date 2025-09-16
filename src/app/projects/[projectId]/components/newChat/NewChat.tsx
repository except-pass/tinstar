import { type FC, useState } from "react";
import { Checkbox } from "../../../../../components/ui/checkbox";
import { ChatInput, useNewChatMutation } from "../chatForm";

export const NewChat: FC<{
  projectId: string;
  onSuccess?: () => void;
}> = ({ projectId, onSuccess }) => {
  const [createWorktree, setCreateWorktree] = useState(false);
  const startNewChat = useNewChatMutation(projectId, onSuccess);

  const handleSubmit = async (message: string) => {
    await startNewChat.mutateAsync({ message, createWorktree });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="create-worktree"
            checked={createWorktree}
            onCheckedChange={(checked) => {
              if (typeof checked === "boolean") {
                setCreateWorktree(checked);
              }
            }}
            disabled={startNewChat.isPending}
          />
          <label
            htmlFor="create-worktree"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            🌱 Start in new worktree
          </label>
        </div>
        {createWorktree && (
          <div className="text-xs text-muted-foreground">
            Creates isolated environment for this conversation
          </div>
        )}
      </div>

      <ChatInput
        projectId={projectId}
        onSubmit={handleSubmit}
        isPending={startNewChat.isPending}
        error={startNewChat.error}
        placeholder="Type your message here... (Start with / for commands, @ for files, Ctrl+Enter to send)"
        buttonText={
          startNewChat.isPending && createWorktree
            ? "Creating Worktree..."
            : createWorktree
              ? "Start Chat in Worktree"
              : "Start Chat"
        }
        minHeight="min-h-[200px]"
        containerClassName="space-y-4"
      />
    </div>
  );
};
