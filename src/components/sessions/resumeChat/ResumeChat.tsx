import { Edit3, Rocket } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useConfig } from "@/app/hooks/useConfig";
import {
  ChatInput,
  type ChatInputRef,
  useResumeChatMutation,
} from "@/components/projects/chatForm";
import { useSetPermissionModeMutation } from "@/components/projects/chatForm/useChatMutations";
import { Button } from "@/components/ui/button";
import type { PermissionMode } from "@/server/service/claude-code/types";

export interface ResumeChatRef {
  focusInput: () => void;
  blurInput: () => void;
}

export const ResumeChat = forwardRef<
  ResumeChatRef,
  {
    projectId: string;
    sessionId: string;
    isPausedTask: boolean;
    isRunningTask: boolean;
    isOrphaned?: boolean;
    hasExitPlanMode?: boolean;
    plan?: string | null;
    currentPermissionMode?: PermissionMode;
  }
>(
  (
    {
      projectId,
      sessionId,
      isPausedTask,
      isRunningTask,
      isOrphaned,
      hasExitPlanMode,
      plan,
      currentPermissionMode,
    },
    ref,
  ) => {
    const resumeChat = useResumeChatMutation(projectId, sessionId);
    const { config } = useConfig();
    const chatInputRef = useRef<ChatInputRef>(null);
    const setPermissionMode = useSetPermissionModeMutation(
      projectId,
      sessionId,
    );
    const [showPlanApproval, setShowPlanApproval] = useState(hasExitPlanMode);
    const [selectedButton, setSelectedButton] = useState<"lets-go" | "modify">(
      "lets-go",
    );

    const hasLatestExitPlan = Boolean(hasExitPlanMode && plan);

    // Expose focus and blur methods
    useImperativeHandle(
      ref,
      () => ({
        focusInput: () => {
          chatInputRef.current?.focus();
        },
        blurInput: () => {
          chatInputRef.current?.blur();
        },
      }),
      [],
    );

    // Reset plan approval UI when a new plan arrives
    useEffect(() => {
      if (hasLatestExitPlan) {
        setShowPlanApproval(true);
        setSelectedButton("lets-go");
      }
    }, [hasLatestExitPlan]);
    // Reset plan approval UI when a new plan arrives
    useEffect(() => {
      if (hasExitPlanMode) {
        setShowPlanApproval(true);
        setSelectedButton("lets-go");
      }
    }, [hasExitPlanMode]);

    const letsGoButtonRef = useRef<HTMLButtonElement>(null);
    const modifyButtonRef = useRef<HTMLButtonElement>(null);

    const handleLetsGo = useCallback(async () => {
      try {
        // Set permission mode to acceptEdits/code mode
        await setPermissionMode.mutateAsync("acceptEdits");
        setShowPlanApproval(false);
        // Send a message to continue with the plan
        await resumeChat.mutateAsync({ message: "Continue with the plan" });
      } catch (error) {
        console.error("Failed to switch permission mode:", error);
      }
    }, [setPermissionMode, resumeChat]);

    const handleModifyPlan = useCallback(async () => {
      try {
        // Set permission mode to plan mode
        await setPermissionMode.mutateAsync("plan");
        // Hide plan approval UI and show normal chat input for user to type modifications
        setShowPlanApproval(false);
        // Note: Would be nice to focus the input here, but ChatInput doesn't expose a ref yet
      } catch (error) {
        console.error("Failed to switch to plan mode:", error);
      }
    }, [setPermissionMode]);
    // Auto-focus the first button when plan approval is shown
    useEffect(() => {
      if (showPlanApproval && plan) {
        letsGoButtonRef.current?.focus();
      }
    }, [showPlanApproval, plan]);

    // Handle keyboard navigation
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!showPlanApproval || !plan) return;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedButton("modify");
          modifyButtonRef.current?.focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedButton("lets-go");
          letsGoButtonRef.current?.focus();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (selectedButton === "lets-go") {
            handleLetsGo();
          } else {
            handleModifyPlan();
          }
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
      showPlanApproval,
      plan,
      selectedButton,
      handleLetsGo,
      handleModifyPlan,
    ]);

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

    // Show plan approval UI only when latest assistant returned a plan and we are in plan mode
    if (showPlanApproval && plan && currentPermissionMode === "plan") {
      return (
        <div className="border-t border-border/50 bg-muted/20 p-4 mt-6">
          <div className="space-y-3">
            {/* Action buttons - stacked vertically */}
            <div className="flex flex-col gap-2 max-w-sm">
              <Button
                ref={letsGoButtonRef}
                size="default"
                variant={selectedButton === "lets-go" ? "default" : "outline"}
                onClick={handleLetsGo}
                onFocus={() => setSelectedButton("lets-go")}
                disabled={setPermissionMode.isPending || resumeChat.isPending}
                className={`justify-start ${
                  selectedButton === "lets-go"
                    ? "bg-green-600 hover:bg-green-700 ring-2 ring-green-400 ring-offset-2"
                    : ""
                }`}
              >
                <Rocket className="h-4 w-4 mr-2" />
                {setPermissionMode.isPending || resumeChat.isPending
                  ? "Switching..."
                  : "Let's gooooooo"}
              </Button>
              <Button
                ref={modifyButtonRef}
                size="default"
                variant="outline"
                onClick={handleModifyPlan}
                onFocus={() => setSelectedButton("modify")}
                disabled={setPermissionMode.isPending}
                className={`justify-start ${
                  selectedButton === "modify"
                    ? "ring-2 ring-primary ring-offset-2"
                    : ""
                }`}
              >
                <Edit3 className="h-4 w-4 mr-2" />
                Modify plan
              </Button>
            </div>

            {/* Keyboard hints */}
            <div className="text-xs text-muted-foreground">
              Use ↑/↓ arrows to navigate, Enter to select
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="border-t border-border/50 bg-muted/20 p-4 mt-6">
        <ChatInput
          ref={chatInputRef}
          projectId={projectId}
          onSubmit={handleSubmit}
          isPending={resumeChat.isPending}
          error={resumeChat.error}
          placeholder={
            currentPermissionMode === "plan"
              ? "Suggest changes to the plan..."
              : "Type your message... (Start with / for commands, Ctrl+Enter to send)"
          }
          buttonText={getButtonText()}
          minHeight="min-h-[100px]"
          containerClassName="space-y-2"
          buttonSize="default"
          sendKeys={config?.sendKeys}
        />
      </div>
    );
  },
);

ResumeChat.displayName = "ResumeChat";
