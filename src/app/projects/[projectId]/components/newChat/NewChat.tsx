import { Code, Map as MapIcon } from "lucide-react";
import { type FC, useId, useState } from "react";
import { useConfig } from "@/app/hooks/useConfig";
import { Checkbox } from "@/components/ui/checkbox";
import { ModelBadge } from "@/components/ui/model-selector";
import { ProjectSelector } from "@/components/ui/project-selector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjects } from "@/app/projects/hooks/useProjects";
import { ChatInput, useNewChatMutation } from "../chatForm";

export const NewChat: FC<{
  projectId?: string; // Made optional to support global modal
  onSuccess?: () => void;
}> = ({ projectId, onSuccess }) => {
  const { config, updateConfig } = useConfig();
  const worktreeCheckboxId = useId();
  const setAsDefaultCheckboxId = useId();
  
  // Always fetch projects; only used in global mode (no projectId)
  const { data: projects } = useProjects();
  
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(
    projectId || config?.defaultProjectId || projects?.[0]?.id
  );
  const [createWorktree, setCreateWorktree] = useState(false);
  const [planMode, setPlanMode] = useState(config?.defaultPlanMode ?? true);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [model] = useState<string | undefined>(
    config?.defaultModel || "default",
  );
  
  const finalProjectId = projectId || selectedProjectId;
  const startNewChat = useNewChatMutation(finalProjectId || "", onSuccess);

  const handleSubmit = async (message: string) => {
    // Update default project if requested and in global mode
    if (!projectId && setAsDefault && selectedProjectId && config) {
      updateConfig({
        ...config,
        defaultProjectId: selectedProjectId,
      });
    }
    
    await startNewChat.mutateAsync({
      message,
      createWorktree,
      planMode,
      model,
    });
  };

  return (
    <div className="space-y-4">
      {/* Project Selection - only show in global mode */}
      {!projectId && projects && (
        <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
          <div className="space-y-2">
            <label className="text-sm font-medium">Project</label>
            <ProjectSelector
              projects={projects as any}
              value={selectedProjectId}
              onValueChange={setSelectedProjectId}
              placeholder="Select a project..."
              className="w-full"
            />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id={setAsDefaultCheckboxId}
              checked={setAsDefault}
              onCheckedChange={(checked) => {
                if (typeof checked === "boolean") {
                  setSetAsDefault(checked);
                }
              }}
              disabled={startNewChat.isPending}
            />
            <label
              htmlFor={setAsDefaultCheckboxId}
              className="text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
            >
              Set as default project
            </label>
          </div>
        </div>
      )}

	<Tabs
		value={planMode ? "plan" : "code"}
		onValueChange={(value) => setPlanMode(value === "plan")}
	>
		{/* Inline row: Plan/Code toggle | Worktree checkbox | Model selector */}
		<div className="flex flex-wrap items-center gap-3">
			<TabsList className="grid grid-cols-2 w-fit">
				<TabsTrigger value="plan" disabled={startNewChat.isPending}>
					<MapIcon className="h-4 w-4" />
					Plan Mode
				</TabsTrigger>
				<TabsTrigger value="code" disabled={startNewChat.isPending}>
					<Code className="h-4 w-4" />
					Code Mode
				</TabsTrigger>
			</TabsList>

			<div className="inline-flex items-center space-x-2 p-3 bg-muted/50 rounded-lg">
				<Checkbox
					id={worktreeCheckboxId}
					checked={createWorktree}
					onCheckedChange={(checked) => {
						if (typeof checked === "boolean") {
							setCreateWorktree(checked);
						}
					}}
					disabled={startNewChat.isPending}
				/>
				<label
					htmlFor={worktreeCheckboxId}
					className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
				>
					🌱 Start in new worktree
				</label>
			</div>

			<div className="inline-flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
				<span className="text-sm font-medium">Model:</span>
				<ModelBadge model={model} className="text-xs" />
			</div>
		</div>

		{createWorktree && (
			<div className="text-xs text-muted-foreground ml-1">
				Creates isolated environment for this conversation
			</div>
		)}

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

      <ChatInput
        projectId={finalProjectId || ""}
        onSubmit={handleSubmit}
        isPending={startNewChat.isPending || (!projectId && !selectedProjectId)}
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
