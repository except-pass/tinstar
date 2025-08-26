The project pane is a ui element to manage projects.  

It is a thin vertical pane that has a Project Widget for each open project in tinstar (check tinstar/projects).  

Project pane overview
- Project Widget 1
- Project Widget 2
...
- Project Widget N
- New Project button

## Data Source
The project pane gets its list of projects from GET /api/projects which returns a ProjectResponse with a projects array. Each project has: name, path, created_at, default_branch, and unignore_paths.

## Project Widget
[name of project]   [refresh button] [gear button] [X close button]
[filelist ui]

The filelist ui should have no lines changed stats, but it should have an open editor button next to each file.  Use the filelist widget from ui/filelist

Projects are color coded.  Each Project Widget should have a background color taken from ui/color_palette.md (cycle through the 8 colors: Desert Sand, Saddle Brown, Rust Red, Gunmetal Gray, Prairie Gold, Cactus Green, Dusty Sky, Charred Wood). Use the color coded project consistently throughout the project.

Refresh should reload the filelist.
Gear button should open a settings dialog for editing unignore paths.
X close button should close the project using DELETE /api/projects/{name}.

## New Project Button
Below all the Project widgets is a new project button.  This opens a directory select dialog (use browser's native directory picker with webkitdirectory). The selected directory is opened as a project using POST /api/projects with the directory path.

Show helpful error messages to the user if they choose an invalid directory.  Pass error messages from the API response. You may need to enhance the API's error messages to be user-friendly.

## Project Settings Dialog
When the gear button is clicked, open a modal dialog with:
- Project name (read-only display)
- Multiline text input for unignore_paths (one path per line), prepopulated with existing values
- Save button to update the project via PUT /api/projects/{name}
- Cancel button to close without saving

The unignore_paths should be displayed one per line in the text area, prepopulated from the current project's unignore_paths array. All paths are relative to the project (repo) root. When saving, split by newlines and trim whitespace to create the updated unignore_paths array for the PUT request. Show validation errors from the API if paths are invalid.

## Error Handling
- Display API errors in a dismissible banner at the top of the project pane
- For directory selection: show specific validation messages (invalid path, not a git repo, permissions, etc.)
- For settings dialog: show validation errors inline within the dialog
- For network errors: provide retry options where appropriate

## Implementation Notes
- Use React with TypeScript
- Follow existing patterns in ui/filelist for component structure
- Integrate with existing FileTree component but disable git stats display
- Handle loading states for all async operations (project list, create, update, delete)
- Use the design.md file for detailed technical specifications

