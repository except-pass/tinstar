import type { FC } from "react";
import {
  ChatInput,
  useResumeChatMutation,
} from "../../../../components/chatForm";

export const ResumeChat: FC<{
  projectId: string;
  sessionId: string;
  isPausedTask: boolean;
  isRunningTask: boolean;
  isOrphaned?: boolean;
}> = ({ projectId, sessionId, isPausedTask, isRunningTask, isOrphaned }) => {
  const resumeChat = useResumeChatMutation(projectId, sessionId);

  const handleSubmit = async (message: string) => {
    await resumeChat.mutateAsync({ message });
  };

  const getButtonText = () => {
    if (isPausedTask || isRunningTask) {
      return "Send";
    }
    return "Resume";
  };

  if (isOrphaned) {
    return (
      <div className="border-t border-border/50 bg-muted/20 p-4 mt-6">
        <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
            <div className="text-2xl">⛓️‍💥</div>
            <div>
              <p className="font-medium text-sm">Chat Disabled</p>
              <p className="text-xs">
                This worktree has been removed. New messages cannot be sent to
                orphaned sessions.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border/50 bg-muted/20 p-4 mt-6">
      <ChatInput
        projectId={projectId}
        onSubmit={handleSubmit}
        isPending={resumeChat.isPending}
        error={resumeChat.error}
        placeholder="Type your message... (Start with / for commands, Ctrl+Enter to send)"
        buttonText={getButtonText()}
        minHeight="min-h-[100px]"
        containerClassName="space-y-2"
        buttonSize="default"
      />
    </div>
  );
};
