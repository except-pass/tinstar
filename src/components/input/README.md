# Input Widget System

A clean, extensible architecture for user input widgets that separates concerns and makes it easy to create different input types.

## Architecture Overview

### Core Components

- **BaseInput**: Core textarea component with cursor tracking, focus management, and keyboard handling
- **TriggerPlugin**: Plugin system for detecting input patterns (/, @, custom patterns)
- **CompletionPlugin**: Manages overlay positioning and completion UI lifecycle
- **InputConfig**: Type-safe configuration for triggers, completions, placeholders, etc.

### Plugin System

- **SlashCommandTrigger**: Handles "/" command detection and palette opening
- **FileCompletionTrigger**: Handles "@" file completion
- **FileCompletionPlugin**: Renders file completion UI with optimal positioning

### Widget Variants

- **PromptInput**: For planning mode with plan-specific features
- **CodeInput**: For code mode with development-focused features
- **NewSessionInput**: For new session creation with mode selection
- **ConfigurableInput**: Uses presets and global configuration system

### Configuration System

- **InputConfigProvider**: React context for sharing configuration
- **InputPresets**: Predefined configurations for common use cases
- **useInputConfig**: Hook for accessing global configuration

## Usage Examples

### Basic Usage with Presets

```tsx
import { ConfigurableInput, InputConfigProvider } from '@/components/input';

// Wrap your app with the provider
<InputConfigProvider>
  <YourApp />
</InputConfigProvider>

// Use predefined presets
<ConfigurableInput
  projectId="project-123"
  preset="PLAN_MODE"
  onSubmit={handleSubmit}
/>

<ConfigurableInput
  projectId="project-123"
  preset="CODE_MODE"
  onSubmit={handleSubmit}
/>
```

### Custom Configuration

```tsx
<ConfigurableInput
  projectId="project-123"
  preset="PLAN_MODE"
  configOverrides={{
    placeholder: "Custom placeholder...",
    minHeight: "min-h-[150px]",
    maxLength: 2000,
  }}
  onSubmit={handleSubmit}
/>
```

### Using Specific Widget Variants

```tsx
import { PromptInput, CodeInput, NewSessionInput } from '@/components/input';

// For plan mode
<PromptInput
  projectId="project-123"
  onSubmit={handleSubmit}
  placeholder="Suggest changes..."
/>

// For code mode
<CodeInput
  projectId="project-123"
  onSubmit={handleSubmit}
  placeholder="Type your message..."
/>

// For new sessions
<NewSessionInput
  projectId="project-123"
  onSubmit={handleSubmit}
  planMode={true}
  createWorktree={false}
/>
```

### Creating Custom Triggers

```tsx
import { TriggerPlugin, TriggerMatch, TriggerContext } from '@/components/input';

class CustomTrigger implements TriggerPlugin {
  readonly name = "custom-trigger";
  readonly triggers = ["!"];

  detect(input: string, cursorPosition: number): TriggerMatch | null {
    // Your detection logic
    if (input.startsWith("!")) {
      return {
        type: "custom-trigger",
        trigger: "!",
        position: 0,
        query: input.substring(1),
        fullMatch: input,
      };
    }
    return null;
  }

  onTrigger(match: TriggerMatch, context: TriggerContext): void {
    // Handle trigger activation
    console.log("Custom trigger activated:", match);
  }
}
```

### Creating Custom Completions

```tsx
import { CompletionPlugin } from '@/components/input';

class CustomCompletionPlugin implements CompletionPlugin {
  readonly name = "custom-completion";

  render(props) {
    if (props.match.type !== "custom-trigger") return null;
    
    return (
      <div className="absolute top-full mt-1 bg-white border rounded shadow">
        {/* Your completion UI */}
      </div>
    );
  }
}
```

## Available Presets

- **PLAN_MODE**: For planning and discussion
- **CODE_MODE**: For development and coding
- **NEW_SESSION**: For creating new sessions
- **COMPACT**: For quick messages (60px height, 500 char limit)
- **LONG_FORM**: For detailed content (300px height, 10000 char limit)

## Benefits

✅ **Separation of Concerns**: Clear boundaries between input, triggers, and widgets  
✅ **Extensibility**: Easy to add new trigger types and input variants  
✅ **Reusability**: Common input logic shared across all widgets  
✅ **Type Safety**: Strong typing for configurations and plugin interfaces  
✅ **Testability**: Each component can be tested in isolation  
✅ **Consistency**: Unified behavior across different input contexts

## Migration Guide

### From ChatInput to New System

**Before:**
```tsx
<ChatInput
  projectId={projectId}
  onSubmit={onSubmit}
  placeholder="Type message..."
  buttonText="Send"
  sendKeys={["ctrl", "cmd"]}
/>
```

**After:**
```tsx
<ConfigurableInput
  projectId={projectId}
  onSubmit={onSubmit}
  preset="CODE_MODE"
  configOverrides={{
    placeholder: "Type message...",
    buttonText: "Send",
  }}
/>
```

### Context-Specific Widgets

**Before:**
```tsx
// Different ChatInput usage in different contexts
<ChatInput {...props} placeholder={mode === "plan" ? "Plan..." : "Code..."} />
```

**After:**
```tsx
// Use appropriate widget
const InputWidget = mode === "plan" ? PromptInput : CodeInput;
<InputWidget {...props} />
```