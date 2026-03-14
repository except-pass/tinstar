import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { compress } from "hono/compress";
import { setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { configSchema } from "../config/config";
import { ClaudeCodeTaskController } from "../service/claude-code/ClaudeCodeTaskController";
import type { SerializableAliveTask } from "../service/claude-code/types";
import { getEventBus } from "../service/events/EventBus";
import { getFileWatcher } from "../service/events/fileWatcher";
import { sseEventResponse } from "../service/events/sseEventResponse";
import { getFileCompletion } from "../service/file-completion/getFileCompletion";
import { commit } from "../service/git/commit";
import { getBranches } from "../service/git/getBranches";
import { getCommits } from "../service/git/getCommits";
import { getDiff } from "../service/git/getDiff";
import { getMcpList } from "../service/mcp/getMcpList";
import { getProject } from "../service/project/getProject";
import { getProjects } from "../service/project/getProjects";
import { runTaskAssessment, buildAssessmentPrompt } from "../service/tasks/assessment";
import { listProjectTasks, saveProjectTasks } from "../service/tasks/storage";
import { deleteSession } from "../service/session/deleteSession";
import { getSession } from "../service/session/getSession";
import { getSessionCwd } from "../service/session/getSessionCwd";
import { getSessions } from "../service/session/getSessions";
import { sessionPermissionModeStorage } from "../service/sessionPermissionModes/storage";
import type { HonoAppType } from "./app";
import { configMiddleware } from "./middleware/config.middleware";

/**
 * Generate ETag from file stats for caching
 */
const generateETag = (filePath: string, mtime: number, size: number): string => {
  // ETag format: "mtime-size-hash"
  const pathHash = Buffer.from(filePath).toString("base64").slice(0, 8);
  return `"${mtime}-${size}-${pathHash}"`;
};

export const routes = (app: HonoAppType) => {
  const taskController = new ClaudeCodeTaskController();

  return (
    app
      // middleware
      .use(configMiddleware)
      .use(compress())

      // routes
      .get("/config", async (c) => {
        return c.json({
          config: c.get("config"),
        });
      })

      .put("/config", zValidator("json", configSchema), async (c) => {
        const { ...config } = c.req.valid("json");

        setCookie(c, "ccv-config", JSON.stringify(config));

        return c.json({
          config,
        });
      })

      .get("/projects", async (c) => {
        const { projects } = await getProjects();
        return c.json({ projects });
      })

      .get("/projects/:projectId", async (c) => {
        const { projectId } = c.req.param();

        const [{ project }, { sessions }, tasks] = await Promise.all([
          getProject(projectId),
          getSessions(projectId).then(({ sessions }) => {
            let filteredSessions = sessions;

            // Filter sessions based on hideNoUserMessageSession setting
            if (c.get("config").hideNoUserMessageSession) {
              filteredSessions = filteredSessions.filter((session) => {
                return session.meta.firstCommand !== null;
              });
            }

            // Unify sessions with same title if unifySameTitleSession is enabled
            if (c.get("config").unifySameTitleSession) {
              const sessionMap = new Map<
                string,
                (typeof filteredSessions)[0]
              >();

              for (const session of filteredSessions) {
                // Generate title for comparison
                const title =
                  session.meta.firstCommand !== null
                    ? (() => {
                        const cmd = session.meta.firstCommand;
                        switch (cmd.kind) {
                          case "command":
                            return cmd.commandArgs === undefined
                              ? cmd.commandName
                              : `${cmd.commandName} ${cmd.commandArgs}`;
                          case "local-command":
                            return cmd.stdout;
                          case "text":
                            return cmd.content;
                          default:
                            return session.id;
                        }
                      })()
                    : session.id;

                const existingSession = sessionMap.get(title);
                if (existingSession) {
                  // Keep the session with the latest modification date
                  if (
                    session.meta.lastModifiedAt &&
                    existingSession.meta.lastModifiedAt
                  ) {
                    if (
                      new Date(session.meta.lastModifiedAt) >
                      new Date(existingSession.meta.lastModifiedAt)
                    ) {
                      sessionMap.set(title, session);
                    }
                  } else if (
                    session.meta.lastModifiedAt &&
                    !existingSession.meta.lastModifiedAt
                  ) {
                    sessionMap.set(title, session);
                  }
                  // If no modification dates, keep the existing one
                } else {
                  sessionMap.set(title, session);
                }
              }

              filteredSessions = Array.from(sessionMap.values());
            }

            return {
              sessions: filteredSessions,
            };
          }),
          listProjectTasks(projectId),
        ] as const);

        return c.json({ project, sessions, tasks });
      })

      .post(
        "/projects/:projectId/tasks",
        zValidator(
          "json",
          z.object({
            name: z.string().min(1),
            summary: z.string().default(""),
            description: z.string().min(1),
            definitionOfDone: z.string().min(1),
            acceptanceCriteria: z.array(z.string()).default([]),
          }),
        ),
        async (c) => {
          const { projectId } = c.req.param();
          const payload = c.req.valid("json");

          const tasks = await listProjectTasks(projectId);
          const task = {
            id: randomUUID(),
            ...payload,
            progressEstimate: null,
          };

          tasks.unshift(task);
          await saveProjectTasks(projectId, tasks);

          return c.json({ task });
        },
      )

      .post(
        "/projects/:projectId/tasks/:taskId/assess-progress",
        async (c) => {
          const { projectId, taskId } = c.req.param();
          const [{ project }, tasks] = await Promise.all([
            getProject(projectId),
            listProjectTasks(projectId),
          ]);

          if (project.meta.projectPath === null) {
            return c.json({ error: "Project path not found" }, 400);
          }

          const taskIndex = tasks.findIndex((task) => task.id === taskId);
          if (taskIndex === -1) {
            return c.json({ error: "Task not found" }, 404);
          }

          const task = tasks[taskIndex];
          const prompt = buildAssessmentPrompt(
            task,
            `Repository path: ${project.meta.projectPath}`,
          );

          try {
            const { estimate, sessionId } = await runTaskAssessment({
              taskController,
              projectId,
              cwd: project.meta.projectPath,
              prompt,
            });

            const progressEstimate = {
              ...estimate,
              assessedAt: new Date().toISOString(),
              assessmentRunId: sessionId,
            };

            tasks[taskIndex] = {
              ...task,
              progressEstimate,
            };
            await saveProjectTasks(projectId, tasks);

            return c.json({ progressEstimate });
          } catch (error) {
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to assess progress",
              },
              500,
            );
          }
        },
      )

      .get("/projects/:projectId/sessions/:sessionId", async (c) => {
        const { projectId, sessionId } = c.req.param();

        try {
          const { session } = await getSession(projectId, sessionId);

          // Generate ETag from file stats
          const stats = await stat(session.jsonlFilePath);
          const etag = generateETag(session.jsonlFilePath, stats.mtime.getTime(), stats.size);

          // Check if client has cached version
          const ifNoneMatch = c.req.header("If-None-Match");
          if (ifNoneMatch === etag) {
            // Client has current version, return 304 Not Modified
            c.header("ETag", etag);
            return c.body(null, 304);
          }

          // Set ETag header for future caching
          c.header("ETag", etag);
          c.header("Cache-Control", "no-cache"); // Require revalidation but allow caching

          // Log response size for debugging
          const responseSize = JSON.stringify({ session }).length;
          console.log(`[API] Session response size: ${responseSize} bytes (${(responseSize / 1024).toFixed(1)}KB) for ${sessionId.slice(0, 8)}...`);

          return c.json({ session });
        } catch (error) {
          console.error("Session fetch error:", error);
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return c.json({ error: "Session not found" }, 404);
          }
          return c.json({ error: "Failed to fetch session" }, 500);
        }
      })

      .delete("/projects/:projectId/sessions/:sessionId", async (c) => {
        const { projectId, sessionId } = c.req.param();
        
        try {
          const result = await deleteSession(projectId, sessionId);
          
          if (result.success) {
            return c.json({
              success: true,
              message: result.message,
              recoveryPath: result.recoveryPath,
            });
          } else {
            return c.json({ error: result.message }, 400);
          }
        } catch (error) {
          console.error("Session deletion error:", error);
          return c.json(
            { 
              error: error instanceof Error 
                ? error.message 
                : "Failed to delete session" 
            }, 
            500
          );
        }
      })

      .get("/projects/:projectId/sessions/:sessionId/cwd", async (c) => {
        const { projectId, sessionId } = c.req.param();
        try {
          const cwd = await getSessionCwd(projectId, sessionId);
          return c.json({ cwd });
        } catch (_error) {
          return c.json(
            { error: "Failed to get session working directory" },
            500,
          );
        }
      })

      .get(
        "/projects/:projectId/file-completion",
        zValidator(
          "query",
          z.object({
            basePath: z.string().optional().default("/"),
          }),
        ),
        async (c) => {
          const { projectId } = c.req.param();
          const { basePath } = c.req.valid("query");

          const { project } = await getProject(projectId);

          if (project.meta.projectPath === null) {
            return c.json({ error: "Project path not found" }, 400);
          }

          try {
            const result = await getFileCompletion(
              project.meta.projectPath,
              basePath,
            );
            return c.json(result);
          } catch (error) {
            console.error("File completion error:", error);
            return c.json({ error: "Failed to get file completion" }, 500);
          }
        },
      )

      .get("/projects/:projectId/claude-commands", async (c) => {
        const { projectId } = c.req.param();
        const { project } = await getProject(projectId);

        const [globalCommands, projectCommands] = await Promise.allSettled([
          readdir(resolve(homedir(), ".claude", "commands"), {
            withFileTypes: true,
          }).then((dirents) =>
            dirents
              .filter((d) => d.isFile() && d.name.endsWith(".md"))
              .map((d) => d.name.replace(/\.md$/, "")),
          ),
          project.meta.projectPath !== null
            ? readdir(
                resolve(project.meta.projectPath, ".claude", "commands"),
                {
                  withFileTypes: true,
                },
              ).then((dirents) =>
                dirents
                  .filter((d) => d.isFile() && d.name.endsWith(".md"))
                  .map((d) => d.name.replace(/\.md$/, "")),
              )
            : [],
        ]);

        return c.json({
          globalCommands:
            globalCommands.status === "fulfilled" ? globalCommands.value : [],
          projectCommands:
            projectCommands.status === "fulfilled" ? projectCommands.value : [],
          defaultCommands: ["init", "compact"],
        });
      })

      .get("/projects/:projectId/git/branches", async (c) => {
        const { projectId } = c.req.param();
        const { project } = await getProject(projectId);

        if (project.meta.projectPath === null) {
          return c.json({ error: "Project path not found" }, 400);
        }

        try {
          const result = await getBranches(project.meta.projectPath);
          return c.json(result);
        } catch (error) {
          console.error("Get branches error:", error);
          if (error instanceof Error) {
            return c.json({ error: error.message }, 400);
          }
          return c.json({ error: "Failed to get branches" }, 500);
        }
      })

      .get("/projects/:projectId/git/commits", async (c) => {
        const { projectId } = c.req.param();
        const { project } = await getProject(projectId);

        if (project.meta.projectPath === null) {
          return c.json({ error: "Project path not found" }, 400);
        }

        try {
          const result = await getCommits(project.meta.projectPath);
          return c.json(result);
        } catch (error) {
          console.error("Get commits error:", error);
          if (error instanceof Error) {
            return c.json({ error: error.message }, 400);
          }
          return c.json({ error: "Failed to get commits" }, 500);
        }
      })

      .post(
        "/projects/:projectId/git/diff",
        zValidator(
          "json",
          z.object({
            fromRef: z.string().min(1, "fromRef is required"),
            toRef: z.string().min(1, "toRef is required"),
          }),
        ),
        async (c) => {
          const { projectId } = c.req.param();
          const { fromRef, toRef } = c.req.valid("json");
          const { project } = await getProject(projectId);

          if (project.meta.projectPath === null) {
            return c.json({ error: "Project path not found" }, 400);
          }

          try {
            const result = await getDiff(
              project.meta.projectPath,
              fromRef,
              toRef,
            );
            return c.json(result);
          } catch (error) {
            console.error("Get diff error:", error);
            if (error instanceof Error) {
              return c.json({ error: error.message }, 400);
            }
            return c.json({ error: "Failed to get diff" }, 500);
          }
        },
      )

      .post(
        "/projects/:projectId/git/commit",
        zValidator(
          "json",
          z.object({
            message: z.string().min(1, "Commit message is required"),
            allChanges: z.boolean().optional().default(false),
            amend: z.boolean().optional().default(false),
          }),
        ),
        async (c) => {
          const { projectId } = c.req.param();
          const { message, allChanges, amend } = c.req.valid("json");
          const { project } = await getProject(projectId);

          if (project.meta.projectPath === null) {
            return c.json({ error: "Project path not found" }, 400);
          }

          try {
            const result = await commit(project.meta.projectPath, {
              message,
              allChanges,
              amend,
            });
            return c.json(result);
          } catch (error) {
            console.error("Git commit error:", error);
            if (error instanceof Error) {
              return c.json({ error: error.message }, 400);
            }
            return c.json({ error: "Failed to commit" }, 500);
          }
        },
      )

      // Session-aware git routes
      .get(
        "/projects/:projectId/sessions/:sessionId/git/branches",
        async (c) => {
          const { projectId, sessionId } = c.req.param();

          try {
            const sessionCwd = await getSessionCwd(projectId, sessionId);
            const result = await getBranches(sessionCwd);
            return c.json(result);
          } catch (error) {
            console.error("Get session branches error:", error);
            if (error instanceof Error) {
              return c.json({ error: error.message }, 400);
            }
            return c.json({ error: "Failed to get session branches" }, 500);
          }
        },
      )

      .get(
        "/projects/:projectId/sessions/:sessionId/git/commits",
        async (c) => {
          const { projectId, sessionId } = c.req.param();

          try {
            const sessionCwd = await getSessionCwd(projectId, sessionId);
            const result = await getCommits(sessionCwd);
            return c.json(result);
          } catch (error) {
            console.error("Get session commits error:", error);
            if (error instanceof Error) {
              return c.json({ error: error.message }, 400);
            }
            return c.json({ error: "Failed to get session commits" }, 500);
          }
        },
      )

      .post(
        "/projects/:projectId/sessions/:sessionId/git/diff",
        zValidator(
          "json",
          z.object({
            fromRef: z.string().min(1, "fromRef is required"),
            toRef: z.string().min(1, "toRef is required"),
          }),
        ),
        async (c) => {
          const { projectId, sessionId } = c.req.param();
          const { fromRef, toRef } = c.req.valid("json");

          try {
            const sessionCwd = await getSessionCwd(projectId, sessionId);
            const result = await getDiff(sessionCwd, fromRef, toRef);
            return c.json(result);
          } catch (error) {
            console.error("Get session diff error:", error);
            if (error instanceof Error) {
              return c.json({ error: error.message }, 400);
            }
            return c.json({ error: "Failed to get session diff" }, 500);
          }
        },
      )

      .post(
        "/projects/:projectId/sessions/:sessionId/git/commit",
        zValidator(
          "json",
          z.object({
            message: z.string().min(1, "Commit message is required"),
            allChanges: z.boolean().optional().default(false),
            amend: z.boolean().optional().default(false),
          }),
        ),
        async (c) => {
          const { projectId, sessionId } = c.req.param();
          const { message, allChanges, amend } = c.req.valid("json");

          try {
            const sessionCwd = await getSessionCwd(projectId, sessionId);
            const result = await commit(sessionCwd, {
              message,
              allChanges,
              amend,
            });
            return c.json(result);
          } catch (error) {
            console.error("Git session commit error:", error);
            if (error instanceof Error) {
              return c.json({ error: error.message }, 400);
            }
            return c.json({ error: "Failed to commit" }, 500);
          }
        },
      )

      .get("/mcp/list", async (c) => {
        const { servers } = await getMcpList();
        return c.json({ servers });
      })

      .post(
        "/projects/:projectId/new-session",
        zValidator(
          "json",
          z.object({
            message: z.string(),
            createWorktree: z.boolean().optional().default(false),
            planMode: z.boolean().optional(),
            model: z.string().optional(),
          }),
        ),
        async (c) => {
          const { projectId } = c.req.param();
          const { message, createWorktree, planMode, model } =
            c.req.valid("json");
          const { project } = await getProject(projectId);
          const config = c.get("config");

          if (project.meta.projectPath === null) {
            return c.json({ error: "Project path not found" }, 400);
          }

          let cwd = project.meta.projectPath;

          if (createWorktree) {
            try {
              // Import worktree management functions
              const { createWorktree: createWorktreeFunc, isGitRepository } =
                await import("../service/worktree/management");

              // Check if project is a git repository
              if (!(await isGitRepository(project.meta.projectPath))) {
                return c.json(
                  { error: "Project is not a git repository" },
                  400,
                );
              }

              // Create worktree
              cwd = await createWorktreeFunc(
                project.meta.projectPath,
                project.claudeProjectPath,
                config.worktreesPath,
              );
            } catch (error) {
              console.error("Failed to create worktree:", error);
              return c.json(
                {
                  error: `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
                },
                500,
              );
            }
          }

          try {
            // Resolve "default" model to "sonnet" for the API
            const resolvedModel = model === "default" ? "sonnet" : model;

            const task = await taskController.startOrContinueTask(
              {
                projectId,
                cwd,
              },
              message,
              planMode ?? config.defaultPlanMode,
              resolvedModel,
            );

            return c.json({
              taskId: task.id,
              sessionId: task.sessionId,
              userMessageId: task.userMessageId,
              worktreePath: createWorktree ? cwd : undefined,
            });
          } catch (error) {
            console.error("Failed to start new session:", error);
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to start session",
              },
              500,
            );
          }
        },
      )

      .post(
        "/projects/:projectId/sessions/:sessionId/resume",
        zValidator(
          "json",
          z.object({
            resumeMessage: z.string(),
            model: z.string().optional(),
          }),
        ),
        async (c) => {
          const { projectId, sessionId } = c.req.param();
          const { resumeMessage, model } = c.req.valid("json");
          const { project } = await getProject(projectId);

          if (project.meta.projectPath === null) {
            return c.json({ error: "Project path not found" }, 400);
          }

          try {
            // Resolve the correct cwd for this session (handles worktree sessions)
            const sessionCwd = await getSessionCwd(projectId, sessionId);

            // Resolve "default" model to "sonnet" for the API
            const resolvedModel = model === "default" ? "sonnet" : model;

            const task = await taskController.startOrContinueTask(
              {
                projectId,
                sessionId,
                cwd: sessionCwd,
              },
              resumeMessage,
              undefined, // planMode not needed for resume
              resolvedModel,
            );

            return c.json({
              taskId: task.id,
              sessionId: task.sessionId,
              userMessageId: task.userMessageId,
            });
          } catch (error) {
            console.error("Failed to resume session:", error);
            return c.json(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to resume session",
              },
              500,
            );
          }
        },
      )

      .get("/tasks/alive", async (c) => {
        return c.json({
          aliveTasks: taskController.aliveTasks.map(
            (task): SerializableAliveTask => ({
              id: task.id,
              status: task.status,
              sessionId: task.sessionId,
              userMessageId: task.userMessageId,
              currentPermissionMode: task.currentPermissionMode,
              model: task.model,
              runPurpose: task.runPurpose,
            }),
          ),
        });
      })

      .post(
        "/tasks/abort",
        zValidator("json", z.object({ sessionId: z.string() })),
        async (c) => {
          const { sessionId } = c.req.valid("json");
          const aborted = taskController.abortTask(sessionId);
          return c.json({
            message: aborted
              ? "Task aborted"
              : "No alive task for given session; nothing to abort",
          });
        },
      )

      .get(
        "/projects/:projectId/sessions/:sessionId/permission-mode",
        async (c) => {
          const { sessionId } = c.req.param();

          // Get stored mode or default to acceptEdits
          const mode =
            sessionPermissionModeStorage.getMode(sessionId) ?? "acceptEdits";

          // Store the default if it wasn't already stored
          if (!sessionPermissionModeStorage.getMode(sessionId)) {
            sessionPermissionModeStorage.setMode(sessionId, mode);
          }

          return c.json({ mode });
        },
      )

      .patch(
        "/projects/:projectId/sessions/:sessionId/permission-mode",
        zValidator(
          "json",
          z.object({
            mode: z.enum(["plan", "acceptEdits"]),
          }),
        ),
        async (c) => {
          const { sessionId } = c.req.param();
          const { mode } = c.req.valid("json");

          // Always update the persistent storage first
          sessionPermissionModeStorage.setMode(sessionId, mode);

          // Also update the active task if one exists
          const taskUpdated = await taskController.setTaskPermissionMode(
            sessionId,
            mode,
          );

          // Return success regardless of whether there's an active task
          // because we successfully updated the stored permission mode
          return c.json({ success: true, mode, taskUpdated });
        },
      )

      .post(
        "/editor-open",
        zValidator(
          "json",
          z.object({
            path: z.string(),
            command: z.string().optional(),
          }),
        ),
        async (c) => {
          const { path, command } = c.req.valid("json");

          // Command resolution order:
          // 1. Command from request
          // 2. Command from cookie/localStorage (via header)
          // 3. $EDITOR environment variable
          // 4. Fallback to cursor
          let editorCommand = command;

          if (!editorCommand) {
            // Try to get from cookie/localStorage via header
            const editorSettings = c.req.header("X-Editor-Settings");
            if (editorSettings) {
              try {
                const settings = JSON.parse(editorSettings);
                if (settings.editorCommand) {
                  editorCommand = settings.editorCommand;
                }
              } catch {
                // Ignore parse errors
              }
            }
          }

          if (!editorCommand) {
            // Try $EDITOR environment variable
            // biome-ignore lint/complexity/useLiteralKeys: Required for TypeScript strict mode
            const envEditor = process.env["EDITOR"];
            if (envEditor) {
              editorCommand = `${envEditor} {{path}}`;
            }
          }

          if (!editorCommand) {
            // Fallback to cursor
            editorCommand = "cursor {{path}}";
          }

          // Replace {{path}} placeholder with actual path
          const finalCommand = editorCommand.replace("{{path}}", path);
          const parts = finalCommand.split(" ");
          const cmd = parts[0];
          const args = parts.slice(1);

          if (!cmd) {
            return c.json({ error: "Invalid editor command" }, 400);
          }

          try {
            return new Promise((resolve, reject) => {
              const childProcess = spawn(cmd, args, {
                stdio: "ignore",
                detached: true,
              });

              childProcess.on("error", (error) => {
                console.error(`Failed to start editor (${cmd}):`, error);
                reject(
                  c.json({ error: `Failed to start editor: ${cmd}` }, 500),
                );
              });

              childProcess.on("spawn", () => {
                // Process started successfully, unref so it doesn't keep the parent alive
                childProcess.unref();
                resolve(
                  c.json({
                    message: `Opened in editor: ${cmd}`,
                    command: finalCommand,
                  }),
                );
              });

              // Timeout after 5 seconds
              setTimeout(() => {
                if (!childProcess.killed) {
                  childProcess.kill();
                  reject(
                    c.json({ error: `Editor command timed out: ${cmd}` }, 500),
                  );
                }
              }, 5000);
            });
          } catch (error) {
            console.error("Error executing editor command:", error);
            return c.json({ error: "Failed to execute editor command" }, 500);
          }
        },
      )

      .get("/events/state_changes", async (c) => {
        return streamSSE(
          c,
          async (stream) => {
            const fileWatcher = getFileWatcher();
            const eventBus = getEventBus();

            let isConnected = true;

            // Heartbeat setup
            const heartbeat = setInterval(() => {
              if (isConnected) {
                eventBus.emit("heartbeat", {
                  type: "heartbeat",
                });
              }
            }, 30 * 1000);

            // connection handling
            const abortController = new AbortController();
            let connectionResolve: ((value: undefined) => void) | undefined;
            const connectionPromise = new Promise<undefined>((resolve) => {
              connectionResolve = resolve;
            });

            const onConnectionClosed = () => {
              isConnected = false;
              connectionResolve?.(undefined);
              abortController.abort();
              clearInterval(heartbeat);
            };

            // Cleanup when connection ends
            stream.onAbort(() => {
              console.log("SSE connection aborted");
              onConnectionClosed();
            });

            // Register event listeners
            console.log("Registering SSE event listeners");
            eventBus.on("connected", async (event) => {
              if (!isConnected) {
                return;
              }
              await stream.writeSSE(sseEventResponse(event)).catch(() => {
                onConnectionClosed();
              });
            });

            eventBus.on("heartbeat", async (event) => {
              if (!isConnected) {
                return;
              }
              await stream.writeSSE(sseEventResponse(event)).catch(() => {
                onConnectionClosed();
              });
            });

            eventBus.on("project_changed", async (event) => {
              if (!isConnected) {
                return;
              }

              await stream.writeSSE(sseEventResponse(event)).catch(() => {
                console.warn("Failed to write SSE event");
                onConnectionClosed();
              });
            });

            eventBus.on("session_changed", async (event) => {
              if (!isConnected) {
                return;
              }

              await stream.writeSSE(sseEventResponse(event)).catch(() => {
                onConnectionClosed();
              });
            });

            eventBus.on("task_changed", async (event) => {
              if (!isConnected) {
                return;
              }

              await stream.writeSSE(sseEventResponse(event)).catch(() => {
                onConnectionClosed();
              });
            });

            // Initial connection confirmation message
            eventBus.emit("connected", {
              type: "connected",
              message: "SSE connection established",
            });

            fileWatcher.startWatching();

            await connectionPromise;
          },
          async (err, stream) => {
            console.error("Streaming error:", err);
            await stream.write("An error occurred.");
          },
        );
      })
  );
};

export type RouteType = ReturnType<typeof routes>;
