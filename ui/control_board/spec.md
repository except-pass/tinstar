The control board is a small collection of buttons that sends commands to the session.  It has the following buttons:

- Stop
- Pause.  Sends the escape key to the session to stop the agent.
- Attach.  Opens a ttymd session
- 4 Notification buttons labeled 1,2,3,4. These are used to respond to notifications on the agent.  Each just does a send_key with that number.  Group these together.

If the underlying API of the controls have an error, display the appropriate error message to the user.  The control board should be resizable horizontally and vertically by click dragging the edge of the control board.