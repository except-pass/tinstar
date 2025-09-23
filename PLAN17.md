# Plan: Combined Sessions View + Granular Time Filter + Project Pills + Enhanced New Chat Modal

## Current State Analysis
- **Preamble issue**: `/` redirects to `/projects` → users browse project-by-project  
- **Binary time filtering**: "Show Old Sessions" checkbox with hard-coded 24-hour cutoff
- **No project context**: Combined sessions need project identification
- **Limited new chat**: New chat modal only works within current project context

## Proposed Changes

### 1. Remove Preamble Pages  
- Redirect `/` directly to combined sessions view instead of `/projects`
- Keep `/projects` route available but not as main entry point

### 2. Replace Binary Time Filter with Granular Options
**Current**: `showOldSessionsAtom` (boolean) → 24h cutoff or all time
**New**: `sessionTimeFilterAtom` (string) → "1h" | "6h" | "1d" | "3d" | "1w" | "1m" | "all"

### 3. Project Color-Coded Pills
- Generate consistent colors using project ID hash + color palette rotation
- Small rounded badges showing project name with background color
- `ProjectPill` component for reuse across views

### 4. Enhanced New Chat Modal with Project Selection
**Current limitation**: Modal only creates chats for current project
**New features**:
- **Project dropdown**: Select which project to create the chat in
- **Default project setting**: Configurable default that persists across sessions
- **Quick project switching**: Easy way to change default without going to settings

**Modal enhancements**:
- Add project selector above message input
- Show project pill next to selected project name
- "Set as default" checkbox/button next to project selector
- Remember last selected project as new default

**Default project management**:
- Add `defaultProjectId` to config schema
- Store in cookie/localStorage like other settings
- Auto-select most recently used project if no default set

### 5. Create Combined Sessions API & Page
- **New endpoint**: `/api/sessions/all` - fetches sessions from all projects
- **New page**: `/app/sessions/page.tsx` - unified sessions view
- Global new chat button that opens enhanced modal

### 6. New Chat Modal Locations
- **Global**: Available in combined sessions view (creates chat for any project)
- **Project-specific**: Keep existing behavior in project pages (pre-selects current project)
- **Consistent UI**: Same modal, different default selections based on context

## Enhanced Modal Flow
1. User clicks "New Chat" from combined sessions view
2. Modal opens with:
   - Project selector (defaulted to saved preference)
   - Message input
   - Model selection (existing)
   - Plan mode toggle (existing)
   - Worktree option (existing)
3. User can quickly change project and optionally set it as new default
4. Chat creates in selected project, user redirected to new session

## Files to Modify
1. `src/app/page.tsx` - Redirect to `/sessions`
2. `src/app/projects/[projectId]/sessions/[sessionId]/store/showOldSessionsAtom.ts` → `sessionTimeFilterAtom.ts`
3. `src/app/projects/[projectId]/sessions/[sessionId]/components/sessionSidebar/SessionsTab.tsx` - Replace checkbox with time selector
4. `src/server/hono/route.ts` - Add `/api/sessions/all` endpoint
5. `src/server/config/config.ts` - Add `defaultProjectId` field
6. `src/app/projects/[projectId]/components/newChat/NewChatModal.tsx` - Add project selection
7. Create `src/app/sessions/page.tsx` - Combined sessions view
8. Create `src/components/ui/time-filter-select.tsx` - Time filter component
9. Create `src/components/ui/project-pill.tsx` - Color-coded project badge
10. Create `src/components/ui/project-selector.tsx` - Project dropdown component

## Benefits  
- **Eliminates preamble**: Direct access to sessions
- **Better time filtering**: Granular time ranges instead of binary
- **Clear project context**: Color-coded pills for instant identification
- **Flexible chat creation**: Create chats for any project from anywhere
- **Smart defaults**: Remembers preferred project for quick access
- **Improved workflow**: Less navigation between projects to create chats