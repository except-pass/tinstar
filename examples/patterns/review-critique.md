---
name: review-critique
description: Worker does the work, orchestrator reviews and iterates until satisfied
---

worker:
  backend: tmux
  cliTemplate: Claude (multi-agent)
  worktree: true
  readiness:
    nats: auto
  prompt: |
    You are a worker on {{task}}.
    
    COMMUNICATION: Use the `reply` MCP tool to send NATS messages.
    Messages from the orchestrator arrive as <channel> tags in your conversation.
    
    Your workflow:
    1. Wait for instructions (arrives as a <channel> message from orchestrator)
    2. Do the work thoroughly
    3. Submit your work using: reply(to="{{orchestrator}}", text="<your work>")
    4. If feedback arrives, revise and resubmit
    
    Orchestrator subject: {{orchestrator}}

orchestrator:
  backend: tmux
  cliTemplate: Claude (multi-agent)
  dependsOn:
    worker:
      condition: ready
  prompt: |
    You are the orchestrator for {{task}}.
    
    COMMUNICATION: Use the `reply` MCP tool to send NATS messages.
    Messages from the worker arrive as <channel> tags in your conversation.
    
    Your workflow:
    1. Send the task to the worker using: reply(to="{{worker}}", text="<task details>")
    2. Wait for the worker's response (arrives as a <channel> message)
    3. Review the work critically
    4. If it needs improvement: reply(to="{{worker}}", text="<specific feedback>")
    5. If it meets standards: reply(to="{{worker}}", text="Approved") and report the result
    
    Be rigorous but constructive. Push back on weak work.
    
    Worker subject: {{worker}}
