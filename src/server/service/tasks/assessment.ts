import type { SDKMessage } from "@anthropic-ai/claude-code";
import { z } from "zod";
import type { ClaudeCodeTaskController } from "../claude-code/ClaudeCodeTaskController";
import type { ProjectTask, TaskProgressEstimate } from "../types";

const assessmentOutputSchema = z.object({
  percentComplete: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  missingPieces: z.array(z.string()),
});

const extractTextContent = (message: SDKMessage): string | null => {
  if (message.type !== "assistant") {
    return null;
  }

  const content = message.message.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  return content
    .map((item) => {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return item.text;
      }
      return "";
    })
    .join("\n");
};

const extractJsonObject = (text: string): string | null => {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1);
};

export const buildAssessmentPrompt = (
  task: ProjectTask,
  repositoryContext: string,
) => {
  return `You are assessing engineering implementation completeness for a software task.\n\nTask Name: ${task.name}\n\nTask Description:\n${task.description}\n\nDefinition of Done:\n${task.definitionOfDone}\n\nAcceptance Criteria:\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}\n\nRepository Context:\n${repositoryContext}\n\nInstructions:\n1. Inspect the codebase in this repository/worktree context.\n2. Compare implementation state against task goal and definition of done.\n3. Estimate percent completion based on engineering weight and substantive completeness, not checklist counting.\n4. Identify major missing pieces.\n5. Return only strict JSON matching:\n{\n  \"percentComplete\": number (0-100),\n  \"confidence\": \"low\" | \"medium\" | \"high\",\n  \"summary\": string,\n  \"missingPieces\": string[]\n}\n\nRubric:\n- 0-10: little/no implementation evidence\n- 10-30: early scaffolding\n- 30-50: meaningful progress, major pieces missing\n- 50-70: core exists, important gaps remain\n- 70-90: most substantive work complete\n- 90-100: implementation appears essentially complete\n\nDo not include markdown or any text outside the JSON object.`;
};

export const runTaskAssessment = async ({
  taskController,
  projectId,
  cwd,
  prompt,
}: {
  taskController: ClaudeCodeTaskController;
  projectId: string;
  cwd: string;
  prompt: string;
}): Promise<{
  estimate: Omit<TaskProgressEstimate, "assessedAt" | "assessmentRunId">;
  sessionId: string;
}> => {
  const assistantTexts: string[] = [];

  let resultResolve: (() => void) | undefined;
  const resultPromise = new Promise<void>((resolve) => {
    resultResolve = resolve;
  });

  const aliveTask = await taskController.startOrContinueTask(
    {
      projectId,
      cwd,
    },
    prompt,
    false,
    undefined,
    {
      runPurpose: "task-assessment",
      onMessage: async (message) => {
        const text = extractTextContent(message);
        if (text) {
          assistantTexts.push(text);
        }

        if (message.type === "result") {
          resultResolve?.();
        }
      },
    },
  );

  try {
    await resultPromise;
  } catch (error) {
    taskController.markTaskFailed(aliveTask.id);
    throw error;
  }

  const combined = assistantTexts.join("\n\n");
  const jsonPayload = extractJsonObject(combined);

  if (!jsonPayload) {
    taskController.markTaskFailed(aliveTask.id);
    throw new Error("Assessment output was malformed: JSON not found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload);
  } catch {
    taskController.markTaskFailed(aliveTask.id);
    throw new Error("Assessment output was malformed: invalid JSON");
  }

  const validated = assessmentOutputSchema.safeParse(parsed);
  if (!validated.success) {
    taskController.markTaskFailed(aliveTask.id);
    throw new Error("Assessment output was malformed: schema mismatch");
  }

  return {
    estimate: validated.data,
    sessionId: aliveTask.sessionId,
  };
};
