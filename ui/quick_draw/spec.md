Quick draw is a feature that lets you quickly navigate the UI using a keyboard.  It works by guiding users though combinations of keys.
At the top of the screen, show a small quick draw icon.  Clicking it opens an overlay that explains the quick draw feature.


There are 2 levels of quick draw.  The "namespace" and the "action".  The namespace is the first key pressed.  The action is the second key pressed.
After the user presses the first key to select a namespace, the pressed key and the namespace should appear next to the quick draw icon.  This lets the user know what namespace they are in.  Pressing escape will clear the namespace.  The icon should show the list of actions available given the namespace.


Namespace: Agent.  'a'
Actions
- select an agent from the agent pane.  'a' selects the first agent, 's' selects the second agent, 'd' the third and so on.  do this for the keys `asdfghjkl;`
- launch a new agent.  'n'.  


Namespace: Details.  'd'
Actions
- pull focus onto the prompt text input area.  'p'
