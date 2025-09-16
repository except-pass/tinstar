## Backlog Items

* **Prompt-Share Tracking**
  Capture when prompts are entered into Tinstar vs directly into a Claude Code agent.

* **Disengagement Observability**
  Add instrumentation to detect where users fall back or disengage.

  * Track when UI elements are expanded.
  * Detect when prompts are entered “the old-fashioned way” by comparing UI-logged prompts against session data.

* **Meta Agent**
  Provide an ephemeral agent that can chat with file diffs and Claude session data to answer context-specific questions.

* **QA Agent**
  Automate QA by scanning file diffs for issues (e.g., antipatterns, hard-coded data, removed tests).

  * Use data from what people ask the meta agent to refine what the QA agent looks for.

* **Invisible Worktrees**
  Explore automatic worktree management so users don’t have to deal with them directly.

  * Must balance this with the principle of not turning into full Git management software.

* **Automatic Commits & Rollback**
  Commit changes automatically and surface them unobtrusively in the conversation timeline.

  * Provide a rollback option via a lightweight confirmation button.
