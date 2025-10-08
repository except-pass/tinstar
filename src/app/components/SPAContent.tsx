"use client";

import { useAtom } from "jotai";
import {
  CodeIcon,
  Command,
  CopyIcon,
  GitCompareIcon,
  InfoIcon,
  Sparkles,
  StopCircleIcon,
} from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfig } from "@/app/hooks/useConfig";
import { SlashCommandPalette } from "@/components/commands/SlashCommandPalette";
import { useSetPermissionModeMutation, useStopTaskMutation } from "@/components/projects/chatForm/useChatMutations";
import { ConversationList } from "@/components/sessions/conversationList/ConversationList";
import { DiffModal } from "@/components/sessions/diffModal";
import {
  ResumeChat,
  type ResumeChatRef,
} from "@/components/sessions/resumeChat/ResumeChat";
import { Button } from "@/components/ui/button";
import { ModeBadge } from "@/components/ui/mode-badge";
import { ModelBadge } from "@/components/ui/model-selector";
import { WorktreeBadge } from "@/components/ui/worktree-badge";
import { useAliveTask } from "@/hooks/sessions/useAliveTask";
import { useCombinedSessions } from "@/hooks/sessions/useCombinedSessions";
import { useSession } from "@/hooks/sessions/useSession";
import { useSessionCwd } from "@/hooks/sessions/useSessionCwd";
import { useSessionPermissionMode } from "@/hooks/sessions/useSessionPermissionMode";
import { useGlobalKeyboardShortcuts } from "@/hooks/useGlobalKeyboardShortcuts";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { useTaskNotifications } from "@/hooks/useTaskNotifications";
import { commandPaletteOpenAtom } from "@/lib/atoms/commandPaletteAtom";
import { currentSessionAtom } from "@/lib/atoms/currentSessionAtom";
import { firstCommandToTitle } from "@/lib/services/firstCommandToTitle";
import { cn } from "@/lib/utils";
import { isWorktreeSession } from "@/lib/worktree-utils";
import { SlashCommandsBootstrap } from "./SlashCommandsBootstrap";
import { UnifiedSidebar, type UnifiedSidebarRef } from "./UnifiedSidebar";

export const SPAContent: FC = () => {
  const { data: allSessions } = useCombinedSessions();
  const [currentSession, setCurrentSession] = useAtom(currentSessionAtom);

  // Initialize with the first session if none selected
  useEffect(() => {
    if (!currentSession && allSessions.length > 0) {
      const firstSession = allSessions[0];
      if (firstSession) {
        setCurrentSession({
          sessionId: firstSession.session.id,
          projectId: firstSession.projectId,
        });
      }
    }
  }, [currentSession, allSessions, setCurrentSession]);

  // If no session is selected yet, show loading
  if (!currentSession) {
    return (
      <>
        <SlashCommandsBootstrap />
        <SlashCommandPalette />
        <div className="flex h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                <div className="w-3 h-3 bg-primary rounded-full animate-bounce" />
                <div className="w-3 h-3 bg-primary rounded-full animate-bounce [animation-delay:0.1s]" />
                <div className="w-3 h-3 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
            <p className="text-lg text-muted-foreground font-medium">
              Loading sessions...
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <SlashCommandsBootstrap />
      <SlashCommandPalette />
      <SessionContent
        projectId={currentSession.projectId}
        sessionId={currentSession.sessionId}
      />
    </>
  );
};

const SessionContent: FC<{
  projectId: string;
  sessionId: string;
}> = ({ projectId, sessionId }) => {
  const { session, conversations, getToolResult } = useSession(
    projectId,
    sessionId,
  );
  const [, setPaletteOpen] = useAtom(commandPaletteOpenAtom);
  const { data: sessionCwd } = useSessionCwd(projectId, sessionId);
  const { openInEditor } = useOpenInEditor();
  const { config } = useConfig();

  const { isRunningTask, isPausedTask, currentPermissionMode, aliveTask } =
    useAliveTask(sessionId);

  const { data: storedPermissionMode } = useSessionPermissionMode(
    projectId,
    sessionId,
  );

  const displayPermissionMode = currentPermissionMode ?? storedPermissionMode;

  const effectiveModel = useMemo(() => {
    if (aliveTask?.model) {
      return aliveTask.model;
    }

    const defaultModel = config?.defaultModel || "default";

    if (defaultModel === "opusplan") {
      if (displayPermissionMode === "plan") {
        return "opus";
      }
      return "sonnet";
    }

    return defaultModel;
  }, [aliveTask?.model, config?.defaultModel, displayPermissionMode]);

  const setPermissionMode = useSetPermissionModeMutation(projectId, sessionId);
  const stopTask = useStopTaskMutation(sessionId);

  const handleModeToggle = async () => {
    if (!displayPermissionMode) return;

    const newMode = displayPermissionMode === "plan" ? "acceptEdits" : "plan";

    try {
      await setPermissionMode.mutateAsync(newMode);
    } catch (error) {
      console.error("Failed to toggle permission mode:", error);
      toast.error("Failed to switch mode");
    }
  };

  const handleStopTask = async () => {
    try {
      await stopTask.mutateAsync();
      toast.success("Task stopped successfully");
    } catch (error) {
      console.error("Failed to stop task:", error);
      toast.error("Failed to stop task");
    }
  };

  const exitPlanModeData = useMemo(() => {
    if (!conversations) return { hasExitPlanMode: false, plan: null };

    let lastExitPlanMode = null;

    for (const conversation of conversations) {
      if (conversation.type === "assistant") {
        for (const content of conversation.message.content) {
          if (content.type === "tool_use" && content.name === "ExitPlanMode") {
            const input = content.input as { plan?: string };
            lastExitPlanMode = {
              hasExitPlanMode: true,
              plan: input.plan || "No plan details available",
            };
          }
        }
      }
    }

    return lastExitPlanMode || { hasExitPlanMode: false, plan: null };
  }, [conversations]);

  useTaskNotifications(isRunningTask || isPausedTask);

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
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [previousSessionId, setPreviousSessionId] = useState(sessionId);
  const hasAutoScrolledRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const isContentUpdatingRef = useRef(false);
  const resumeChatRef = useRef<ResumeChatRef>(null);
  const sidebarRef = useRef<UnifiedSidebarRef>(null);

  // Reset auto-scroll state when session changes
  useEffect(() => {
    hasAutoScrolledRef.current = false;
    setIsAutoScrollEnabled(true);
  }, []);

  const isAtBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return false;
    return (
      scrollContainer.scrollTop + scrollContainer.clientHeight >=
      scrollContainer.scrollHeight - 10
    );
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior,
      });
    }
  }, []);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      if (isUserScrollingRef.current || isContentUpdatingRef.current) return;

      if (isAtBottom()) {
        setIsAutoScrollEnabled(true);
      } else {
        setIsAutoScrollEnabled(false);
      }
    };

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [isAtBottom]);

  useEffect(() => {
    if (previousSessionId !== sessionId) {
      setPreviousSessionId(sessionId);
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

  useEffect(() => {
    if (hasAutoScrolledRef.current) return;
    if (conversations.length === 0) return;

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

  useEffect(() => {
    if (
      (isRunningTask || isPausedTask) &&
      conversations.length !== previousConversationLength
    ) {
      setPreviousConversationLength(conversations.length);

      if (isAutoScrollEnabled) {
        isContentUpdatingRef.current = true;
        isUserScrollingRef.current = true;

        scrollToBottom("smooth");

        setTimeout(() => {
          isUserScrollingRef.current = false;
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

  useGlobalKeyboardShortcuts({
    onNavigateUp: () => {
      sidebarRef.current?.navigateUp();
    },
    onNavigateDown: () => {
      sidebarRef.current?.navigateDown();
    },
    onCreateNew: () => {
      sidebarRef.current?.createNew();
    },
    onOpenEditor: () => {
      if (sessionCwd) {
        openInEditor(sessionCwd);
      }
    },
    onFocusInput: () => {
      resumeChatRef.current?.focusInput();
    },
    onBlurInput: () => {
      resumeChatRef.current?.blurInput();
    },
  });

  return (
    <div className="flex h-screen max-h-screen overflow-hidden">
      <UnifiedSidebar ref={sidebarRef} />

      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <header className="px-2 sm:px-3 py-2 sm:py-3 sticky top-0 z-10 bg-background w-full flex-shrink-0 min-w-0">
          <div className="space-y-2 sm:space-y-3">
            <div className="flex items-center gap-2 sm:gap-3">
              <h1 className="text-lg sm:text-2xl md:text-3xl font-bold break-all overflow-ellipsis line-clamp-1 px-1 sm:px-5 min-w-0">
                {session.meta.firstCommand !== null
                  ? firstCommandToTitle(session.meta.firstCommand)
                  : sessionId}
              </h1>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaletteOpen(true)}
                className="h-7 px-2 hidden sm:inline-flex"
                title="Open Commands (Ctrl/Cmd+K)"
              >
                <Sparkles className="w-4 h-4" />
                <span className="ml-1 hidden md:inline">Commands</span>
                <span className="ml-2 hidden lg:flex items-center gap-1 rounded border border-border px-1.5 py-0 text-[10px] text-muted-foreground">
                  <Command className="w-3 h-3" />K
                </span>
              </Button>
            </div>

            <div className="px-1 sm:px-5 flex flex-wrap items-center gap-1 sm:gap-2">
              {sessionCwd && (
                <div className="relative group">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openInEditor(sessionCwd)}
                    className="h-6 sm:h-8 text-xs sm:text-sm flex items-center gap-1 px-2 sm:px-3 hover:bg-blue-50/60 hover:border-blue-300/60 hover:shadow-sm transition-all duration-200"
                  >
                    <CodeIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                    Open in Code Editor
                  </Button>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-900 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
                    Open current directory in code editor
                  </div>
                </div>
              )}
              <div className="flex items-center gap-1">
                <div className="relative group">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={copyResumeCommand}
                    disabled={!sessionCwd}
                    className="h-6 sm:h-8 text-xs sm:text-sm flex items-center gap-1 px-2 sm:px-3 hover:bg-blue-50/60 hover:border-blue-300/60 hover:shadow-sm transition-all duration-200"
                  >
                    <CopyIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                    Claude Code link
                  </Button>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-900 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
                    Copies claude code command to clipboard
                  </div>
                </div>
                {(isRunningTask || isPausedTask) && (
                  <div className="relative group">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleStopTask}
                      disabled={stopTask.isPending}
                      className="h-6 sm:h-8 text-xs sm:text-sm flex items-center gap-1 px-2 sm:px-3"
                    >
                      <StopCircleIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                      Stop
                    </Button>
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-900 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
                      Stop Claude Code task
                    </div>
                  </div>
                )}
                <div className="relative group">
                  <button
                    className="h-6 sm:h-8 px-1 flex items-center text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
                    type="button"
                  >
                    <InfoIcon className="w-3 h-3 sm:w-4 sm:h-4" />
                  </button>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-900 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
                    Session ID: {sessionId}
                  </div>
                </div>
              </div>

              {/* Auto-scroll toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  Auto-scroll
                </span>
                <button
                  type="button"
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
              {displayPermissionMode && (
                <ModeBadge
                  mode={displayPermissionMode}
                  className="h-6 sm:h-8 text-xs sm:text-sm"
                  onClick={handleModeToggle}
                  disabled={setPermissionMode.isPending || isRunningTask}
                />
              )}
              {effectiveModel && (
                <ModelBadge
                  model={effectiveModel}
                  className="h-6 sm:h-8 text-xs sm:text-sm"
                />
              )}
              {isWorktreeSession(session.jsonlFilePath) && (
                <WorktreeBadge
                  className="h-6 sm:h-8 text-xs sm:text-sm"
                  isDirty={session.meta.isDirty}
                  isOrphaned={session.meta.isOrphaned}
                />
              )}
            </div>
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
                      <div className="w-2 h-2 bg-primary rounded-full animate-bounce" />
                      <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.1s]" />
                      <div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground font-medium">
                    Claude Code is processing...
                  </p>
                </div>
              </div>
            )}

            <ResumeChat
              ref={resumeChatRef}
              projectId={projectId}
              sessionId={sessionId}
              isPausedTask={isPausedTask}
              isRunningTask={isRunningTask}
              isOrphaned={session.meta.isOrphaned}
              hasExitPlanMode={exitPlanModeData.hasExitPlanMode}
              plan={exitPlanModeData.plan}
              currentPermissionMode={displayPermissionMode}
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
