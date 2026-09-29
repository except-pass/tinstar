# Terminal fit

Isolated home. The worker terminal keeps a 14px font and lets xterm fit the stage, so the columns and rows follow the space on screen and the linked tmux window follows that grid. The detail rail stays beside the terminal above 1200px and collapses to a slim header below that.

![1280 by 720, rail beside the terminal](terminal-fit-1280x720.png)

![1440 by 900, rail beside the terminal](terminal-fit-1440x900.png)

![1920 by 1080, rail beside the terminal](terminal-fit-1920x1080.png)

![1000 by 1080, collapsed detail header](terminal-fit-collapsed-1000x1080.png)

![1000 by 900, collapsed detail header](terminal-fit-collapsed-1000x900.png)

![1000 by 720, collapsed detail header](terminal-fit-collapsed-1000x720.png)

`e2e/cockpit-regression.spec.ts` checks the same edges, including these sizes, on a private tmux socket. The font stays 14px, the grid fills the stage, and the tmux window matches the grid.
