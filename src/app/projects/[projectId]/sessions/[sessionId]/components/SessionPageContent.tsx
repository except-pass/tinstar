"use client";

import { useMutation } from "@tanstack/react-query";
import {
  CopyIcon,
  ExternalLinkIcon,
  GitCompareIcon,
  LoaderIcon,
  MenuIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTaskNotifications } from "@/hooks/useTaskNotifications";
import { cn } from "@/lib/utils";
import { Badge } from "../../../../../../components/ui/badge";
import { WorktreeBadge } from "../../../../../../components/ui/worktree-badge";
import { honoClient } from "../../../../../../lib/api/client";
import { isWorktreeSession } from "../../../../../../lib/worktree-utils";
import { useProject } from "../../../hooks/useProject";
import { firstCommandToTitle } from "../../../services/firstCommandToTitle";
import { useAliveTask } from "../hooks/useAliveTask";
import { useSession } from "../hooks/useSession";
import { useSessionCwd } from "../hooks/useSessionCwd";
import { ConversationList } from "./conversationList/ConversationList";
import { DiffModal } from "./diffModal";
import { ResumeChat } from "./resumeChat/ResumeChat";
import { SessionSidebar } from "./sessionSidebar/SessionSidebar";

export const SessionPageContent: FC<{
  projectId: string;
  sessionId: string;
}> = ({ projectId, sessionId }) => {
  const { session, conversations, getToolResult } = useSession(
    projectId,
    sessionId,
  );
  const { data: project } = useProject(projectId);
  const { data: sessionCwd } = useSessionCwd(projectId, sessionId);

  const abortTask = useMutation({
    mutationFn: async (sessionId: string) => {
      const response = await honoClient.api.tasks.abort.$post({
        json: { sessionId },
      });

      if (!response.ok) {
        throw new Error(response.statusText);
      }

      return response.json();
    },
  });

  const { isRunningTask, isPausedTask } = useAliveTask(sessionId);

  // Set up task completion notifications
  useTaskNotifications(isRunningTask);

  // Copy resume command to clipboard
  const copyResumeCommand = async () => {
    if (!sessionCwd) {
      toast.error("Working directory not available");
      return;
    }

    const command = `cd "${sessionCwd}" && claude -r ${sessionId}`;

    try {
      await navigator.clipboard.writeText(command);
      toast.success(
        "Resume command copied! Go to your terminal and paste to resume the session.",
      );
    } catch (_error) {
      toast.error("Failed to copy command to clipboard");
    }
  };

  const [previousConversationLength, setPreviousConversationLength] =
    useState(0);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [previousSessionId, setPreviousSessionId] = useState(sessionId);
  const hasAutoScrolledRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const isContentUpdatingRef = useRef(false);

  // Reset auto-scroll state when session changes
  useEffect(() => {
    hasAutoScrolledRef.current = false;
    setIsAutoScrollEnabled(true);
  }, []);

  // Utility functions for scroll detection
  const isAtBottom = () => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return false;
    return (
      scrollContainer.scrollTop + scrollContainer.clientHeight >=
      scrollContainer.scrollHeight - 10
    );
  };

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior,
      });
    }
  };

  // Scroll event listener to detect user scroll behavior
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      // Ignore programmatic scrolls and content updates
      if (isUserScrollingRef.current || isContentUpdatingRef.current) return;

      if (isAtBottom()) {
        // User scrolled to bottom, enable auto-scroll
        setIsAutoScrollEnabled(true);
      } else {
        // User scrolled up, disable auto-scroll
        setIsAutoScrollEnabled(false);
      }
    };

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [isAtBottom]);

  // Auto-scroll when switching to a new session (route param change within same component instance)
  useEffect(() => {
    if (previousSessionId !== sessionId) {
      setPreviousSessionId(sessionId);
      // Use setTimeout to ensure the content is fully rendered before scrolling
      setTimeout(() => {
        isUserScrollingRef.current = true;
        scrollToBottom("auto");
        hasAutoScrolledRef.current = true;
        setTimeout(() => {
          isUserScrollingRef.current = false;
        }, 100);
      }, 0);
    }
  }, [sessionId, previousSessionId, scrollToBottom]);

  // Auto-scroll on initial mount after conversations render (covers remounts on navigation)
  useEffect(() => {
    if (hasAutoScrolledRef.current) return;
    if (conversations.length === 0) return;

    // Next tick to ensure layout is complete
    const id = setTimeout(() => {
      isUserScrollingRef.current = true;
      scrollToBottom("auto");
      hasAutoScrolledRef.current = true;
      setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 100);
    }, 0);
    return () => clearTimeout(id);
  }, [conversations.length, scrollToBottom]);

  // New conversation auto-scroll logic
  useEffect(() => {
    if (
      (isRunningTask || isPausedTask) &&
      conversations.length !== previousConversationLength
    ) {
      setPreviousConversationLength(conversations.length);

      if (isAutoScrollEnabled) {
        // Mark that content is updating to prevent scroll events from toggling auto-scroll
        isContentUpdatingRef.current = true;
        isUserScrollingRef.current = true;

        scrollToBottom("smooth");

        // Clear flags after content has settled
        setTimeout(() => {
          isUserScrollingRef.current = false;
          // Give extra time for content to fully render and scroll to complete
          setTimeout(() => {
            isContentUpdatingRef.current = false;
          }, 200);
        }, 100);
      }
    }
  }, [
    conversations,
    isRunningTask,
    isPausedTask,
    previousConversationLength,
    isAutoScrollEnabled,
    scrollToBottom,
  ]);

  return (
    <div className="flex h-screen max-h-screen overflow-hidden">
      <SessionSidebar
        currentSessionId={sessionId}
        projectId={projectId}
        isMobileOpen={isMobileSidebarOpen}
        onMobileOpenChange={setIsMobileSidebarOpen}
      />

      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <header className="px-2 sm:px-3 py-2 sm:py-3 sticky top-0 z-10 bg-background w-full flex-shrink-0 min-w-0">
          <div className="space-y-2 sm:space-y-3">
            <div className="flex items-center gap-2 sm:gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="md:hidden flex-shrink-0"
                onClick={() => setIsMobileSidebarOpen(true)}
              >
                <MenuIcon className="w-4 h-4" />
              </Button>
              <h1 className="text-lg sm:text-2xl md:text-3xl font-bold break-all overflow-ellipsis line-clamp-1 px-1 sm:px-5 min-w-0">
                {session.meta.firstCommand !== null
                  ? firstCommandToTitle(session.meta.firstCommand)
                  : sessionId}
              </h1>
            </div>

            <div className="px-1 sm:px-5 flex flex-wrap items-center gap-1 sm:gap-2">
              {project?.project.claudeProjectPath && (
                <Link
                  href={`/projects/${projectId}`}
                  target="_blank"
                  className="transition-all duration-200"
                >
                  <Badge
                    variant="secondary"
                    className="h-6 sm:h-8 text-xs sm:text-sm flex items-center hover:bg-blue-50/60 hover:border-blue-300/60 hover:shadow-sm transition-all duration-200 cursor-pointer"
                  >
                    <ExternalLinkIcon className="w-3 h-3 sm:w-4 sm:h-4 mr-1" />
                    {project.project.meta.projectPath ??
                      project.project.claudeProjectPath}
                  </Badge>
                </Link>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={copyResumeCommand}
                disabled={!sessionCwd}
                className="h-6 sm:h-8 text-xs sm:text-sm flex items-center gap-1 px-2 sm:px-3 hover:bg-blue-50/60 hover:border-blue-300/60 hover:shadow-sm transition-all duration-200"
                title="Click to copy resume command"
              >
                <span>💻 Session: {sessionId}</span>
                <CopyIcon className="w-3 h-3 opacity-70" />
              </Button>

              {/* Auto-scroll toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  Auto-scroll
                </span>
                <button
                  onClick={() => {
                    if (!isAutoScrollEnabled) {
                      setIsAutoScrollEnabled(true);
                      isUserScrollingRef.current = true;
                      scrollToBottom("smooth");
                      setTimeout(() => {
                        isUserScrollingRef.current = false;
                      }, 100);
                    } else {
                      setIsAutoScrollEnabled(false);
                    }
                  }}
                  className={cn(
                    "relative inline-flex h-5 w-9 sm:h-6 sm:w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary/20",
                    isAutoScrollEnabled ? "bg-green-500" : "bg-gray-200",
                  )}
                  role="switch"
                  aria-checked={isAutoScrollEnabled}
                  title={
                    isAutoScrollEnabled
                      ? "Auto-scroll enabled"
                      : "Auto-scroll disabled"
                  }
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block h-4 w-4 sm:h-5 sm:w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                      isAutoScrollEnabled
                        ? "translate-x-4 sm:translate-x-5"
                        : "translate-x-0",
                    )}
                  />
                </button>
              </div>
              {isWorktreeSession(session.jsonlFilePath) && (
                <WorktreeBadge
                  className="h-6 sm:h-8 text-xs sm:text-sm"
                  isDirty={session.meta.isDirty}
                  isOrphaned={session.meta.isOrphaned}
                />
              )}
            </div>

            {isRunningTask && (
              <div className="flex items-center gap-1 sm:gap-2 p-1 bg-primary/10 border border-primary/20 rounded-lg mx-1 sm:mx-5">
                <LoaderIcon className="w-3 h-3 sm:w-4 sm:h-4 animate-spin" />
                <div className="flex-1">
                  <p className="text-xs sm:text-sm font-medium">
                    Conversation is in progress...
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    abortTask.mutate(sessionId);
                  }}
                >
                  <XIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="hidden sm:inline">Abort</span>
                </Button>
              </div>
            )}

            {isPausedTask && (
              <div className="flex items-center gap-1 sm:gap-2 p-1 bg-primary/10 border border-primary/20 rounded-lg mx-1 sm:mx-5">
                <PauseIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                <div className="flex-1">
                  <p className="text-xs sm:text-sm font-medium">
                    Conversation is paused...
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    abortTask.mutate(sessionId);
                  }}
                >
                  <XIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="hidden sm:inline">Abort</span>
                </Button>
              </div>
            )}
          </div>
        </header>

        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto min-h-0 min-w-0"
        >
          <main className="w-full px-4 sm:px-6 md:px-8 lg:px-12 xl:px-16 relative z-5 min-w-0">
            <ConversationList
              conversations={conversations}
              getToolResult={getToolResult}
            />

            {isRunningTask && (
              <div className="flex justify-start items-center py-8">
                <div className="flex flex-col items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-primary rounded-full animate-bounce"></div>
                      <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.1s]"></div>
                      <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground font-medium">
                    Claude Code is processing...
                  </p>
                </div>
              </div>
            )}

            <ResumeChat
              projectId={projectId}
              sessionId={sessionId}
              isPausedTask={isPausedTask}
              isRunningTask={isRunningTask}
              isOrphaned={session.meta.isOrphaned}
            />
          </main>
        </div>
      </div>

      {/* Fixed Diff Button */}
      <Button
        onClick={() => setIsDiffModalOpen(true)}
        disabled={session.meta.isOrphaned}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 z-50"
        size="lg"
        title={
          session.meta.isOrphaned
            ? "Worktree directory has been removed. Git operations are disabled for this session."
            : "Show git diff"
        }
      >
        <GitCompareIcon className="w-6 h-6" />
      </Button>

      {/* Diff Modal */}
      <DiffModal
        projectId={projectId}
        sessionId={sessionId}
        isOpen={isDiffModalOpen}
        onOpenChange={setIsDiffModalOpen}
      />
    </div>
  );
};
