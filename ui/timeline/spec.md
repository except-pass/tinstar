The timeline widget shows a timeline of events for a given session.  The important events are


Events
- user prompt inputs
- notifications
- stop
- posttooluse
- todo list updates

In addition to the events, also show the commits from /worktrees/commits

Icons
- Prompt: Show a ...
- Notification: Show a bell
- Stop: Show a stop sign
- Post tool use.  Just call it Tool.  Show a wrench.  Collapse many tool uses into a single icon and just put the number (e.g. :wrench:x20)
- Todo.  Show a checkmark.
- Commit.  Show a floppy disk.

The timeline should show

[User] --P---N-----S
[System] ---.....x20.....D---
[Commits] ------[S]------[S]---


## Prompt
Clicking a user prompt icon will select that prompt.  Show it as selected.

Interaction with the details pane.  The details pane should show always show the initial prompt.  
If the selected prompt is different from the initial prompt, then show the text of the selected prompt (shortened to fit nicely if needed).  

## Notification
If the notification is "active" (it is the last event we got so the user has to deal with it) then the notification icon should be filled in orange.  Otherwise it should be just an outline.

## Commit
On mouse over, show the commit hash and message.









