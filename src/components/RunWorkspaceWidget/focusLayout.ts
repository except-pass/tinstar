const SESSION_MIN_WIDTH = 640
const FILES_RAIL_WIDTH = 24
const TELEMETRY_WIDTH = 160
const TELEMETRY_RAIL_WIDTH = 24
const SLATE_OPENER_WIDTH = 28
const SLATE_MIN_WIDTH = 260

interface FocusWorkspaceLayoutInput {
  width: number
  filesCollapsed: boolean
  filesWidth: number
  slateVisible: boolean
  slateWidth: number
  telemetryCollapsed: boolean
}

export interface FocusWorkspaceLayout {
  constrained: boolean
  fullDemand: number
  filesRail: boolean
  telemetryRail: boolean
  slateWidth: number | null
}

export function resolveFocusWorkspaceLayout({
  width,
  filesCollapsed,
  filesWidth,
  slateVisible,
  slateWidth,
  telemetryCollapsed,
}: FocusWorkspaceLayoutInput): FocusWorkspaceLayout {
  const fullDemand = (filesCollapsed ? FILES_RAIL_WIDTH : filesWidth)
    + SESSION_MIN_WIDTH
    + (slateVisible ? slateWidth : SLATE_OPENER_WIDTH)
    + (telemetryCollapsed ? TELEMETRY_RAIL_WIDTH : TELEMETRY_WIDTH)
  const constrained = width < fullDemand
  let resolvedSlateWidth: number | null = null
  if (slateVisible) {
    resolvedSlateWidth = constrained
      ? Math.max(SLATE_MIN_WIDTH, Math.min(slateWidth, width * 0.4))
      : slateWidth
  }

  return {
    constrained,
    fullDemand,
    filesRail: constrained || filesCollapsed,
    telemetryRail: constrained || telemetryCollapsed,
    slateWidth: resolvedSlateWidth,
  }
}
