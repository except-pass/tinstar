// Whether the Saloon's Clear button should be enabled: only when there is at
// least one event to clear.
export const canClear = (events: { length: number }): boolean => events.length > 0
