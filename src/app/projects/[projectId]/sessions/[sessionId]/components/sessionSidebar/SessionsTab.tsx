"use client";

import { useAtom, useAtomValue } from "jotai";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useId,
  useState,
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { WorktreeBadge } from "@/components/ui/worktree-badge";
import { cn } from "@/lib/utils";
import { isWorktreeSession } from "@/lib/worktree";
import type { Session } from "../../../../../../../server/service/types";
import { NewChatModal } from "../../../../components/newChat/NewChatModal";
import { firstCommandToTitle } from "../../../../services/firstCommandToTitle";
import { aliveTasksAtom } from "../../store/aliveTasksAtom";
import { showOldSessionsAtom } from "../../store/showOldSessionsAtom";

export interface SessionsTabRef {
  navigateUp: () => void;
  navigateDown: () => void;
  createNew: () => void;
}

export const SessionsTab = forwardRef<
  SessionsTabRef,
  {
    sessions: Session[];
    currentSessionId: string;
    projectId: string;
  }
>(({ sessions, currentSessionId, projectId }, ref) => {
  // Defer hydration-variant values (like Date.now and live counts) until after mount
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    setIsHydrated(true);
  }, []);
  const aliveTasks = useAtomValue(aliveTasksAtom);
  const [showOldSessions, setShowOldSessions] = useAtom(showOldSessionsAtom);
  const checkboxId = useId();
  const router = useRouter();
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(-1);
  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false);
  const newChatButtonRef = useRef<HTMLButtonElement>(null);

  // Filter sessions based on 24-hour cutoff if showOldSessions is false
  const filteredSessions = showOldSessions
    ? sessions
    : isHydrated
      ? sessions.filter((session) => {
          if (!session.meta.lastModifiedAt) return false;
          const sessionTime = new Date(session.meta.lastModifiedAt).getTime();
          const cutoffTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
          return sessionTime > cutoffTime;
        })
      : sessions; // Before hydration, avoid Date.now()-based filtering to prevent SSR mismatches

  // Sort sessions: Running > Paused > Others, then by lastModifiedAt (newest first)
  const sortedSessions = [...filteredSessions].sort((a, b) => {
    const aTask = aliveTasks.find((task) => task.sessionId === a.id);
    const bTask = aliveTasks.find((task) => task.sessionId === b.id);

    const aStatus = aTask?.status;
    const bStatus = bTask?.status;

    // Define priority: running = 0, paused = 1, others = 2
    const getPriority = (status: string | undefined) => {
      if (status === "running") return 0;
      if (status === "paused") return 1;
      return 2;
    };

    const aPriority = getPriority(aStatus);
    const bPriority = getPriority(bStatus);

    // First sort by priority
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    // Then sort by lastModifiedAt (newest first)
    const aTime = a.meta.lastModifiedAt
      ? new Date(a.meta.lastModifiedAt).getTime()
      : 0;
    const bTime = b.meta.lastModifiedAt
      ? new Date(b.meta.lastModifiedAt).getTime()
      : 0;
    return bTime - aTime;
  });

  // Find current session index in sorted list
  useEffect(() => {
    const currentIndex = sortedSessions.findIndex(
      (session) => session.id === currentSessionId,
    );
    setSelectedSessionIndex(currentIndex);
  }, [sortedSessions, currentSessionId]);

  // Navigation functions with immediate feedback
  const navigateUp = useCallback(() => {
    if (sortedSessions.length === 0) return;
    const newIndex =
      selectedSessionIndex > 0
        ? selectedSessionIndex - 1
        : sortedSessions.length - 1;
    const targetSession = sortedSessions[newIndex];
    if (targetSession) {
      // Update state immediately for responsive UI
      setSelectedSessionIndex(newIndex);
      // Navigate without adding to history for faster transitions
      router.replace(
        `/projects/${projectId}/sessions/${encodeURIComponent(targetSession.id)}`,
        { scroll: false },
      );
    }
  }, [sortedSessions, selectedSessionIndex, projectId, router]);

  const navigateDown = useCallback(() => {
    if (sortedSessions.length === 0) return;
    const newIndex =
      selectedSessionIndex < sortedSessions.length - 1
        ? selectedSessionIndex + 1
        : 0;
    const targetSession = sortedSessions[newIndex];
    if (targetSession) {
      // Update state immediately for responsive UI
      setSelectedSessionIndex(newIndex);
      // Navigate without adding to history for faster transitions
      router.replace(
        `/projects/${projectId}/sessions/${encodeURIComponent(targetSession.id)}`,
        { scroll: false },
      );
    }
  }, [sortedSessions, selectedSessionIndex, projectId, router]);

  const createNew = () => {
    setIsNewChatModalOpen(true);
  };

  // Expose methods through ref
  useImperativeHandle(
    ref,
    () => ({
      navigateUp,
      navigateDown,
      createNew,
    }),
    [navigateUp, navigateDown],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-sidebar-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-lg">Sessions</h2>
          <NewChatModal
            projectId={projectId}
            isOpen={isNewChatModalOpen}
            onOpenChange={setIsNewChatModalOpen}
            trigger={
              <Button
                ref={newChatButtonRef}
                size="sm"
                variant="outline"
                className="gap-1.5"
              >
                <PlusIcon className="w-3.5 h-3.5" />
                New
              </Button>
            }
          />
        </div>
        <div className="flex items-center justify-between text-xs text-sidebar-foreground/70">
          <span>{isHydrated ? `${sortedSessions.length} total` : ""}</span>
          <div className="flex items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={showOldSessions}
              onCheckedChange={(checked) => {
                if (typeof checked === "boolean") {
                  setShowOldSessions(checked);
                }
              }}
            />
            <label htmlFor={checkboxId} className="text-xs cursor-pointer">
              Show Old Sessions
            </label>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {sortedSessions.map((session) => {
          const isActive = session.id === currentSessionId;
          const title =
            session.meta.firstCommand !== null
              ? firstCommandToTitle(session.meta.firstCommand)
              : session.id;

          const aliveTask = aliveTasks.find(
            (task) => task.sessionId === session.id,
          );
          const isRunning = aliveTask?.status === "running";
          const isPaused = aliveTask?.status === "paused";

          return (
            <Link
              key={session.id}
              href={`/projects/${projectId}/sessions/${encodeURIComponent(
                session.id,
              )}`}
              className={cn(
                "block rounded-lg p-2.5 transition-all duration-200 hover:bg-blue-50/60 hover:border-blue-300/60 hover:shadow-sm border border-sidebar-border/40 bg-sidebar/30",
                isActive &&
                  "bg-blue-100 border-blue-400 shadow-md ring-1 ring-blue-200/50 hover:bg-blue-100 hover:border-blue-400",
              )}
            >
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1">
                    <h3 className="text-sm font-medium line-clamp-2 leading-tight text-sidebar-foreground">
                      {title}
                    </h3>
                    {isWorktreeSession(session.jsonlFilePath) && (
                      <WorktreeBadge
                        className="text-xs"
                        isDirty={session.meta.isDirty}
                        isOrphaned={session.meta.isOrphaned}
                      />
                    )}
                  </div>
                  {(isRunning || isPaused) && (
                    <Badge
                      variant={isRunning ? "default" : "secondary"}
                      className={cn(
                        "text-xs",
                        isRunning && "bg-green-500 text-white",
                        isPaused && "bg-yellow-500 text-white",
                      )}
                    >
                      {isRunning ? "Running" : "Paused"}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-xs text-sidebar-foreground/70">
                    <MessageSquareIcon className="w-3 h-3" />
                    <span>{isHydrated ? session.meta.messageCount : ""}</span>
                  </div>
                  {session.meta.lastModifiedAt && (
                    <span className="text-xs text-sidebar-foreground/60">
                      {new Date(session.meta.lastModifiedAt).toLocaleDateString(
                        "en-US",
                        {
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        },
                      )}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
});

SessionsTab.displayName = "SessionsTab";
