import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { honoClient } from "@/lib/api/client";

export const useNewChatMutation = (
  projectId: string,
  onSuccess?: () => void,
) => {
  const router = useRouter();

  return useMutation({
    mutationFn: async (options: {
      message: string;
      createWorktree?: boolean;
      planMode?: boolean;
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
      router.push(
        `/projects/${projectId}/sessions/${response.sessionId}#message-${response.userMessageId}`,
      );
    },
  });
};

export const useResumeChatMutation = (projectId: string, sessionId: string) => {
  const router = useRouter();

  return useMutation({
    mutationFn: async (options: { message: string }) => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ].resume.$post(
        {
          param: { projectId, sessionId },
          json: { resumeMessage: options.message },
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
      if (sessionId !== response.sessionId) {
        router.push(
          `/projects/${projectId}/sessions/${response.sessionId}#message-${response.userMessageId}`,
        );
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
