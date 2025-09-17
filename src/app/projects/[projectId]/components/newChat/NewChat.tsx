import { Code, Map } from "lucide-react";
import { type FC, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ModelBadge } from "@/components/ui/model-selector";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useConfig } from "@/app/hooks/useConfig";
import { ChatInput, useNewChatMutation } from "../chatForm";

export const NewChat: FC<{
  projectId: string;
  onSuccess?: () => void;
}> = ({ projectId, onSuccess }) => {
  const { config } = useConfig();
  const [createWorktree, setCreateWorktree] = useState(false);
  const [planMode, setPlanMode] = useState(config?.defaultPlanMode ?? true);
  const [model] = useState<string | undefined>(config?.defaultModel || "default");
  const startNewChat = useNewChatMutation(projectId, onSuccess);


  const handleSubmit = async (message: string) => {
    await startNewChat.mutateAsync({
      message,
      createWorktree,
      planMode,
      model,
    });
  };

  return (
    <div className="space-y-4">
      <Tabs
        value={planMode ? "plan" : "code"}
        onValueChange={(value) => setPlanMode(value === "plan")}
      >
        <TabsList className="grid grid-cols-2 w-fit">
          <TabsTrigger value="plan" disabled={startNewChat.isPending}>
            <Map className="h-4 w-4" />
            Plan Mode
          </TabsTrigger>
          <TabsTrigger value="code" disabled={startNewChat.isPending}>
            <Code className="h-4 w-4" />
            Code Mode
          </TabsTrigger>
        </TabsList>
        <TabsContent value="plan" className="space-y-2">
          <div className="text-sm text-muted-foreground">
            Claude will plan out changes before making them. You can review and
            approve the plan before execution.
          </div>
        </TabsContent>
        <TabsContent value="code" className="space-y-2">
          <div className="text-sm text-muted-foreground">
            Claude will immediately make changes to your code. Edits still
            require approval.
          </div>
        </TabsContent>
      </Tabs>

      <div className="space-y-3">
        <div className="space-y-2">
          <div className="inline-flex items-center space-x-2 p-3 bg-muted/50 rounded-lg">
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
            <div className="text-xs text-muted-foreground ml-3">
              Creates isolated environment for this conversation
            </div>
          )}
        </div>

        <div className="inline-flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
          <span className="text-sm font-medium">Model:</span>
          <ModelBadge model={model} className="text-xs" />
        </div>
      </div>

      <ChatInput
        projectId={projectId}
        onSubmit={handleSubmit}
        isPending={startNewChat.isPending}
        error={startNewChat.error}
        placeholder={
          planMode
            ? "Describe what you want to build... (Claude will plan before coding)"
            : "Type your message here... (Claude will start coding immediately)"
        }
        buttonText={
          startNewChat.isPending && createWorktree
            ? "Creating Worktree..."
            : createWorktree
              ? `Start ${planMode ? "Planning" : "Coding"} in Worktree`
              : `Start ${planMode ? "Planning" : "Coding"}`
        }
        minHeight="min-h-[200px]"
        containerClassName="space-y-4"
        sendKeys={config?.sendKeys}
      />
    </div>
  );
};
