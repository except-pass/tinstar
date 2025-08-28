# Quick Draw UI Component Specification

## Overview

Quick Draw is a keyboard navigation system that allows users to quickly navigate and interact with the UI using two-level keyboard shortcuts. The system consists of namespaces (first key) and actions (second key), providing rapid access to common operations without mouse interaction.

## Visual Design

### Quick Draw Icon

Quick Draw icon, with no active namespace
Show the following icon

[⚡🤠 Quick Draw]
Upon mouse over, give a tooltip that explains the feature
```
Quick Draw - Keyboard shortcuts for rapid UI navigation

  Press a key to select a category, then another key to execute an action. No mouse needed - just fast, two-key combinations to get where you're going.  Press the first key to get started
  [a] - Agents
  (More on the way)
```

Upon pressing 'a' to select a namespace
```
┌─ Top Bar ─────────────────────────────────┐
│  Agents a+        │ ← Quick Draw icon + active namespace
└───────────────────────────────────────────┘
```

### Help Context Overlay
```
┌─ Main UI with Help Overlay ──────────────────┐
│ ┌─ Agent Pane ──────┐                        │
│ │ ⚡ agent-1    [a]  │ ← Key hints over       │
│ │ ⚡ agent-2    [s]  │   actionable elements  │
│ │ ⚡ agent-3    [d]  │                        │
│ │ + New Agent  [n]  │                        │
│ └───────────────────┘                        │
│ [Translucent overlay with key hints]         │
└───────────────────────────────────────────── ┘
```

## Component Structure

### QuickDraw Manager
- **Quick Draw Icon**: Always visible in top bar
- **Namespace Indicator**: Shows active namespace (e.g., "a: Agent")
- **Help Context Overlay**: Appears after 2-second timeout
- **Action Registry**: Extensible system for registering new shortcuts

### Key Components
1. **QuickDrawIcon**: Clickable icon that shows help/explanation
2. **NamespaceIndicator**: Shows current active namespace
3. **HelpContextOverlay**: Translucent overlay with key hints
4. **ActionRegistry**: System for managing keyboard shortcuts

## Namespaces and Actions

### Agent Namespace ('a')
| Key | Action | Description |
|-----|---------|-------------|
| a,s,d,f,g,h,j,k,l,; | Select Agent | Select agents 1-10 from agent pane |
| n | New Agent | Launch new agent creation dialog |

### Future Namespaces (Extensible)
New namespaces and actions must be easy to add and maintain.

## State Management

```typescript
interface QuickDrawState {
  isActive: boolean
  activeNamespace: string | null
  showHelpContext: boolean
  helpTimeout: NodeJS.Timeout | null
  registeredActions: ActionRegistry
}

interface KeyBinding {
  namespace: string
  key: string
  action: () => void
  description: string
  targetSelector?: string  // CSS selector for help overlay positioning
}

interface ActionRegistry {
  [namespace: string]: {
    [key: string]: KeyBinding
  }
}
```

## Interaction Flow

### Basic Usage
1. User presses namespace key (e.g., 'a')
2. Namespace indicator appears: "Agent: a+".  The + symbol invites the user to press another key.
3. User presses action key (e.g., 's')
4. Action executes (selects second agent)
5. Quick Draw resets to inactive state

### Help Context Flow
1. User presses namespace key (e.g., 'a')
2. System starts 2-second timeout
3. If no action taken within 2 seconds:
   - Help Context overlay appears
   - Key hints positioned over actionable elements
   - User can still execute actions normally
4. Overlay dismisses after action or ESC key

### Escape Behavior
- **ESC during namespace**: Clear active namespace, return to inactive
- **ESC during help context**: Clear help overlay and namespace

## Architecture for Extensibility

### Action Registration System
```typescript
class QuickDrawRegistry {
  private actions: ActionRegistry = {}
  
  registerNamespace(namespace: string, description: string): void
  registerAction(namespace: string, key: string, binding: KeyBinding): void
  getActions(namespace: string): KeyBinding[]
  getAllNamespaces(): string[]
}

// Usage example:
const registry = new QuickDrawRegistry()

// Register Agent namespace
registry.registerNamespace('a', 'Agent')
registry.registerAction('a', 'n', {
  namespace: 'a',
  key: 'n',
  action: () => createNewAgent(),
  description: 'Launch new agent',
  targetSelector: '[data-testid="new-agent-button"]'
})
```

### Dynamic Help Context Positioning
```typescript
interface HelpHint {
  key: string
  description: string
  targetElement: HTMLElement
  position: { x: number, y: number }
}

const generateHelpHints = (namespace: string): HelpHint[] => {
  const actions = registry.getActions(namespace)
  return actions
    .map(action => {
      const element = document.querySelector(action.targetSelector)
      if (!element) return null
      
      const rect = element.getBoundingClientRect()
      return {
        key: action.key,
        description: action.description,
        targetElement: element,
        position: { x: rect.right + 8, y: rect.top }
      }
    })
    .filter(Boolean)
}
```

## Integration Points

### Agent Pane Integration
- Quick Draw must access agent list for selection actions
- Coordinate with AgentPane component for highlighting selected agents
- Handle dynamic agent list changes (agents added/removed)

### UI Layout Considerations
- **Responsive positioning**: Help overlay adapts to window resizing
- **Z-index management**: Ensure overlay appears above all other UI
- **Focus management**: Maintain keyboard focus during Quick Draw mode
- **Accessibility**: Screen reader announcements for state changes

## Implementation Requirements

### Core Features
- Global keyboard event handling (document level)
- Namespace timeout management
- Dynamic overlay positioning
- Action registry system

### Accessibility
- **Screen readers**: Announce namespace changes and available actions
- **Keyboard navigation**: Full keyboard accessibility
- **High contrast**: Clear visual indicators for active state

### Performance
- Efficient event handling (prevent conflicts with other shortcuts)
- Lazy loading of help context overlays
- Minimal impact on UI responsiveness during overlay rendering

## Error Handling

- **Action failures**: Show error messages without breaking Quick Draw state
- **Missing targets**: Gracefully handle actions when target elements don't exist
- **Registry conflicts**: Warn about duplicate key bindings during development

## Testing Strategy

### Key Scenarios
- **Basic flow**: Namespace → Action → Execute
- **Help context**: Timeout triggers overlay correctly
- **Escape handling**: All escape scenarios work properly
- **Registry system**: Actions can be registered/unregistered dynamically
- **Responsive overlay**: Help hints positioned correctly after window resize
- **Multiple namespaces**: Switch between different namespaces
- **Edge cases**: Rapid key presses, invalid combinations

### Integration Testing
- **Agent selection**: Verify integration with agent pane selection
- **New agent creation**: Verify integration with session creation dialog
- **UI responsiveness**: Ensure no performance impact during normal usage

## Implementation Notes

- Use React with TypeScript
- Global keyboard event listeners with proper cleanup
- CSS-in-JS or styled-components for dynamic overlay positioning
- **Extensibility first**: Design registry system before implementing specific actions
- **Performance considerations**: Debounce overlay positioning during window resize
- **State persistence**: Remember user preferences for help context behavior