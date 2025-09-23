"use client";

import { useAtom, useAtomValue } from "jotai";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProjectPill } from "@/components/ui/project-pill";
import { TimeFilterSelect } from "@/components/ui/time-filter-select";
import { WorktreeBadge } from "@/components/ui/worktree-badge";
import { cn } from "@/lib/utils";
import { isWorktreeSession } from "@/lib/worktree";
import { sessionTimeFilterAtom } from "@/app/projects/[projectId]/sessions/[sessionId]/store/sessionTimeFilterAtom";
import { aliveTasksAtom } from "@/app/projects/[projectId]/sessions/[sessionId]/store/aliveTasksAtom";
import { firstCommandToTitle } from "@/app/projects/[projectId]/services/firstCommandToTitle";
import { NewChatModal } from "@/app/projects/[projectId]/components/newChat/NewChatModal";
import { useProjects } from "@/app/projects/hooks/useProjects";
import { useCombinedSessions } from "../hooks/useCombinedSessions";
import { isSessionWithinTimeFilter } from "../utils/timeFilters";

export function SessionsList() {
  // Defer hydration-variant values (like Date.now and live counts) until after mount
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const sessions = useCombinedSessions();
  const projects = useProjects();
  const aliveTasks = useAtomValue(aliveTasksAtom);
  const [timeFilter, setTimeFilter] = useAtom(sessionTimeFilterAtom);
  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false);

  // Filter sessions based on time filter
  const filteredSessions = sessions.filter((sessionWithProject) => {
    return isSessionWithinTimeFilter(
      sessionWithProject.session.meta.lastModifiedAt,
      timeFilter,
      isHydrated
    );
  });

  // Sort sessions: Running > Paused > Others, then by lastModifiedAt (newest first)
  const sortedSessions = [...filteredSessions].sort((a, b) => {
    const aTask = aliveTasks.find((task) => task.sessionId === a.session.id);
    const bTask = aliveTasks.find((task) => task.sessionId === b.session.id);

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
    const aTime = a.session.meta.lastModifiedAt
      ? new Date(a.session.meta.lastModifiedAt).getTime()
      : 0;
    const bTime = b.session.meta.lastModifiedAt
      ? new Date(b.session.meta.lastModifiedAt).getTime()
      : 0;
    return bTime - aTime;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold">All Sessions</h2>
          <TimeFilterSelect
            value={timeFilter}
            onValueChange={setTimeFilter}
            className="w-40"
          />
          {isHydrated && (
            <span className="text-sm text-muted-foreground">
              {sortedSessions.length} session{sortedSessions.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <NewChatModal
          isOpen={isNewChatModalOpen}
          onOpenChange={setIsNewChatModalOpen}
          trigger={
            <Button className="gap-2">
              <PlusIcon className="w-4 h-4" />
              New Chat
            </Button>
          }
        />
      </div>

      <div className="grid gap-3">
        {sortedSessions.map((sessionWithProject) => {
          const { session, projectId, projectName } = sessionWithProject;
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
              key={`${projectId}-${session.id}`}
              href={`/projects/${projectId}/sessions/${encodeURIComponent(session.id)}`}
              className={cn(
                "block rounded-lg p-4 transition-all duration-200 hover:bg-blue-50/60 hover:border-blue-300/60 hover:shadow-sm border border-border bg-card",
                "hover:shadow-lg"
              )}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <ProjectPill
                        projectId={projectId}
                        projectName={projectName}
                        size="sm"
                      />
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
                    <h3 className="text-base font-medium line-clamp-2 leading-tight text-foreground">
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
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <MessageSquareIcon className="w-4 h-4" />
                    <span>{isHydrated ? session.meta.messageCount : ""} messages</span>
                  </div>
                  {session.meta.lastModifiedAt && (
                    <span className="text-sm text-muted-foreground">
                      {new Date(session.meta.lastModifiedAt).toLocaleDateString(
                        "en-US",
                        {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
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
        
        {sortedSessions.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <MessageSquareIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg mb-2">No sessions found</p>
            <p className="text-sm">
              {timeFilter === "all" 
                ? "No conversation sessions exist yet." 
                : "Try adjusting the time filter or create a new chat."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}