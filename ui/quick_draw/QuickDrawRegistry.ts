export interface KeyBinding {
  namespace: string
  key: string
  action: () => void
  description: string
  targetSelector?: string  // CSS selector for help overlay positioning
}

export interface ActionRegistry {
  [namespace: string]: {
    [key: string]: KeyBinding
  }
}

export interface NamespaceInfo {
  key: string
  name: string
  description: string
}

export class QuickDrawRegistry {
  private actions: ActionRegistry = {}
  private namespaces: { [key: string]: NamespaceInfo } = {}
  
  registerNamespace(key: string, name: string, description: string): void {
    this.namespaces[key] = { key, name, description }
    if (!this.actions[key]) {
      this.actions[key] = {}
    }
  }
  
  registerAction(namespace: string, key: string, binding: KeyBinding): void {
    if (!this.actions[namespace]) {
      this.actions[namespace] = {}
    }
    
    // Warn about duplicate key bindings in development
    if (this.actions[namespace][key]) {
      console.warn(`QuickDraw: Overriding existing action for ${namespace}:${key}`)
    }
    
    this.actions[namespace][key] = binding
  }
  
  getActions(namespace: string): KeyBinding[] {
    if (!this.actions[namespace]) {
      return []
    }
    return Object.values(this.actions[namespace])
  }
  
  getAction(namespace: string, key: string): KeyBinding | null {
    return this.actions[namespace]?.[key] || null
  }
  
  getAllNamespaces(): NamespaceInfo[] {
    return Object.values(this.namespaces)
  }
  
  getNamespace(key: string): NamespaceInfo | null {
    return this.namespaces[key] || null
  }
  
  hasNamespace(key: string): boolean {
    return key in this.namespaces
  }
  
  hasAction(namespace: string, key: string): boolean {
    return !!(this.actions[namespace]?.[key])
  }
  
  clear(): void {
    this.actions = {}
    this.namespaces = {}
  }
}

// Global registry instance
export const quickDrawRegistry = new QuickDrawRegistry()