import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { honoClient } from "@/lib/api/client";
import { currentSessionAtom } from "@/lib/atoms/currentSessionAtom";

export const useNewChatMutation = (
  projectId: string,
  onSuccess?: () => void,
) => {
  const setCurrentSession = useSetAtom(currentSessionAtom);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: {
      message: string;
      createWorktree?: boolean;
      planMode?: boolean;
      model?: string;
    }) => {
      const response = await honoClient.api.projects[":projectId"][
        "new-session"
      ].$post(
        {
          param: { projectId },
          json: {
            message: options.message,
            createWorktree: options.createWorktree ?? false,
            planMode: options.planMode,
            model: options.model,
          },
        },
        {
          init: {
            signal: AbortSignal.timeout(30 * 1000), // Increased timeout for worktree creation
          },
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const message =
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : response.statusText;
        throw new Error(message);
      }

      return response.json();
    },
    onSuccess: async (response) => {
      onSuccess?.();
      // Immediately invalidate the session query to ensure it's ready for SSE updates
      await queryClient.invalidateQueries({
        queryKey: ["sessions", response.sessionId],
      });
      // Switch to the new session in the SPA
      setCurrentSession({
        sessionId: response.sessionId,
        projectId,
      });
    },
  });
};

export const useResumeChatMutation = (projectId: string, sessionId: string) => {
  const setCurrentSession = useSetAtom(currentSessionAtom);

  return useMutation({
    mutationFn: async (options: {
      message: string;
      model?: string;
      fallbackModel?: string;
    }) => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ].resume.$post(
        {
          param: { projectId, sessionId },
          json: {
            resumeMessage: options.message,
            model: options.model,
          },
        },
        {
          init: {
            signal: AbortSignal.timeout(20 * 1000),
          },
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const message =
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : response.statusText;
        throw new Error(message);
      }

      return response.json();
    },
    onSuccess: async (response) => {
      // If a different session is returned (e.g., new worktree session), switch to it
      if (sessionId !== response.sessionId) {
        setCurrentSession({
          sessionId: response.sessionId,
          projectId,
        });
      }
    },
  });
};

export const useSetPermissionModeMutation = (
  projectId: string,
  sessionId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mode: "plan" | "acceptEdits") => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ]["permission-mode"].$patch({
        param: { projectId, sessionId },
        json: { mode },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const message =
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : response.statusText;
        throw new Error(message);
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate the session permission mode query to refetch the updated mode
      queryClient.invalidateQueries({
        queryKey: ["sessionPermissionMode", projectId, sessionId],
      });
      // Also invalidate alive tasks to get the updated mode if task is running
      queryClient.invalidateQueries({
        queryKey: ["aliveTasks"],
      });
    },
  });
};

export const useStopTaskMutation = (sessionId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await honoClient.api.tasks.abort.$post({
        json: { sessionId },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const message =
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : response.statusText;
        throw new Error(message);
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate alive tasks to refetch the updated task states
      queryClient.invalidateQueries({
        queryKey: ["aliveTasks"],
      });
    },
  });
};
