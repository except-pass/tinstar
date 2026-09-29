# Terminal height

Isolated home, one worker, a 220 by 60 window. The cockpit keeps that grid and lowers the font when the stage is shorter than the grid, so row 01 and the bottom prompt are both on screen. The detail rail stays beside the terminal above 1200px and collapses to a slim header below that.

![1440 by 900, rail beside the terminal](terminal-height-1440x900.png)

![1920 by 1080, rail beside the terminal](terminal-height-1920x1080.png)

![1280 by 720, rail beside the terminal](terminal-height-1280x720.png)

![1440 by 700, rail beside the terminal](terminal-height-1440x700.png)

![1000 by 900, collapsed detail header](terminal-height-collapsed-1000x900.png)

![1000 by 700, collapsed detail header](terminal-height-collapsed-1000x700.png)

`e2e/cockpit-regression.spec.ts` checks the same edges, including these sizes, on a private tmux socket.
