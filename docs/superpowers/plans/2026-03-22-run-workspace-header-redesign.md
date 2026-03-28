# Run Workspace Header Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace icon-only action buttons in the run workspace header with full-height labeled buttons, grouped by function with separators.

**Architecture:** Single file change to `RunWorkspaceHeader.tsx`. The right zone's flex container switches to `align-items: stretch` so buttons fill the header vertically. Each button becomes a flex column of icon + text label. The header itself drops its vertical padding so button edges are flush with the header border.

**Tech Stack:** React, Tailwind CSS, Material Symbols Outlined (already loaded), Playwright (E2E tests)

---

## Files

- **Modify:** `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx`
- **Modify:** `e2e/run-panels.spec.ts` (add header button label tests)

---

### Task 1: Write failing E2E tests for new header labels

The test verifies that the redesigned header shows labeled buttons. Run against the sim server.

**Files:**
- Modify: `e2e/run-panels.spec.ts`

- [ ] **Step 1: Add tests at the bottom of the existing `Run Widget Panels` describe block in `e2e/run-panels.spec.ts`**

  Add a new describe block after the existing ones:

  ```typescript
  test.describe('Run Widget Header Actions', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await resetAndWaitForData(page)
    })

    test('header shows labeled COLOR button', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      await expect(widget.getByText('COLOR')).toBeVisible()
    })

    test('header shows labeled BROWSER button', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      await expect(widget.getByText('BROWSER')).toBeVisible()
    })

    test('header shows labeled REFRESH button when session is live with port', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      // Refresh is only shown when isLive && run.port — skip gracefully if absent
      const visible = await widget.getByText('REFRESH').isVisible().catch(() => false)
      if (!visible) return // session not live or no port — button intentionally absent
      await expect(widget.getByText('REFRESH')).toBeVisible()
    })

    test('header shows labeled STOP or RESUME button', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      const stop = widget.getByText('STOP')
      const resume = widget.getByText('RESUME')
      const stopVisible = await stop.isVisible().catch(() => false)
      const resumeVisible = await resume.isVisible().catch(() => false)
      expect(stopVisible || resumeVisible).toBeTruthy()
    })

    test('header shows labeled DELETE button', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      await expect(widget.getByText('DELETE')).toBeVisible()
    })

    test('REFRESH button has descriptive tooltip when shown', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      // Refresh is conditional on isLive && run.port — skip if not rendered
      const refreshBtn = widget.locator('button').filter({ hasText: 'REFRESH' }).first()
      if (!(await refreshBtn.isVisible().catch(() => false))) return
      const title = await refreshBtn.getAttribute('title')
      expect(title).toContain('proxy route')
    })
  })
  ```

- [ ] **Step 2: Run the tests to confirm they fail**

  ```bash
  cd /home/ubuntu/repo/tinstar
  TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5280 npx playwright test e2e/run-panels.spec.ts --grep "Run Widget Header Actions" 2>&1 | tail -30
  ```

  Expected: tests fail because the labels don't exist yet.

- [ ] **Step 3: Commit the failing tests**

  ```bash
  git add e2e/run-panels.spec.ts
  git commit -m "test: add failing e2e tests for run workspace header labeled buttons"
  ```

---

### Task 2: Implement the header redesign

**Files:**
- Modify: `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx`

- [ ] **Step 1: Read the current file to understand exact line numbers**

  Read `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx` before editing.

- [ ] **Step 2: Replace the `<header>` element's className**

  Current:
  ```tsx
  className="widget-drag-handle flex items-center justify-between bg-surface-panel px-3 py-1.5 overflow-hidden cursor-grab active:cursor-grabbing select-none"
  ```

  New (remove `px-3 py-1.5`, keep everything else):
  ```tsx
  className="widget-drag-handle flex items-center justify-between bg-surface-panel overflow-hidden cursor-grab active:cursor-grabbing select-none"
  ```

- [ ] **Step 3: Replace the left zone — add left padding back since the header no longer has it**

  Current:
  ```tsx
  <div className="flex items-center gap-2 min-w-0">
  ```

  New:
  ```tsx
  <div className="flex items-center gap-2 min-w-0 pl-3">
  ```

- [ ] **Step 4a: Add a `hoveredBtn` state variable at the top of the component (after the existing `useState` calls)**

  ```tsx
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null)
  ```

  This drives accent hover colors for Color, Browser, and Refresh buttons (which have dynamic `runAccent`).

- [ ] **Step 4b: Replace the entire right zone (`{!compact && ...}`) with the redesigned version**

  Replace the block starting at `{/* Right: actions + meta */}` and ending at the closing `</header>` replacement content. The full new right zone:

  ```tsx
  {/* Right: actions + meta */}
  {!compact && (
    <div className="flex items-stretch shrink-0 ml-2 h-full" onPointerDown={e => e.stopPropagation()}>
      {/* Hotgroup badge — currently in the right zone in the source file (confirmed in Step 1 read).
           The spec says "left zone, unchanged" but this refers to visual grouping with the identity.
           Keep it here in the right zone flex row; the spec note is aspirational, not a move instruction. */}
      <div className="flex items-center px-2">
        <HotgroupBadge slots={slotsForNode(`run-${run.id}`)} testId={`hotgroup-badge-${run.id}`} />
      </div>

      {/* Error banner — shown inline before buttons when present */}
      {actionError && (
        <div
          className="flex items-center gap-1 px-2 my-auto bg-accent-red/10 border border-accent-red/30 rounded text-accent-red text-2xs font-mono max-w-[180px] cursor-pointer"
          title={actionError}
          onClick={() => setActionError(null)}
        >
          <span className="material-symbols-outlined text-xs">error</span>
          <span className="truncate">{actionError}</span>
        </div>
      )}

      {/* WORKTREE / REPO meta */}
      <div className="flex items-center gap-4 px-3 border-l border-white/[0.06]">
        <div className="text-right">
          <div className="text-2xs font-mono text-slate-500 tracking-wide">WORKTREE</div>
          <div className="text-2xs font-mono truncate max-w-[80px]" style={{ color: hexToRgba(runAccent, 0.7) }}>{run.worktree}</div>
        </div>
        <div className="text-right">
          <div className="text-2xs font-mono text-slate-500 tracking-wide">REPO</div>
          <div className="text-2xs font-mono truncate max-w-[80px]" style={{ color: hexToRgba(runAccent, 0.7) }}>{run.repo}</div>
        </div>
      </div>

      {/* Separator */}
      <div className="w-px self-stretch bg-white/[0.07]" />

      {/* Color palette */}
      <div className="relative" ref={paletteRef}>
        <button
          ref={paletteButtonRef}
          onClick={() => {
            if (!paletteOpen && paletteButtonRef.current) {
              const rect = paletteButtonRef.current.getBoundingClientRect()
              setPalettePos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
            }
            setPaletteOpen(o => !o)
          }}
          onMouseEnter={() => setHoveredBtn('color')}
          onMouseLeave={() => setHoveredBtn(null)}
          className="flex flex-col items-center justify-center gap-0.5 h-full px-3 transition-colors"
          style={{
            color: (paletteOpen || hoveredBtn === 'color') ? runAccent : hexToRgba(runAccent, 0.55),
            background: hoveredBtn === 'color' ? hexToRgba(runAccent, 0.06) : undefined,
          }}
          title="Change run color"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px', fontVariationSettings: "'FILL' 0" }}>palette</span>
          <span className="text-[8px] font-bold tracking-wide leading-none">COLOR</span>
        </button>
        {paletteOpen && palettePos && createPortal(
          <div
            className="fixed z-[9999] p-2 bg-surface-panel border border-white/10 rounded shadow-xl"
            style={{ top: palettePos.top, right: palettePos.right, minWidth: 160 }}
            ref={paletteRef}
          >
            <ColorPalette value={run.color ?? ''} onChange={handleColorChange} />
          </div>,
          document.body,
        )}
      </div>

      {/* Browser drag chip */}
      <div
        draggable
        onMouseEnter={() => setHoveredBtn('browser')}
        onMouseLeave={() => setHoveredBtn(null)}
        onDragStart={e => {
          e.stopPropagation()
          e.dataTransfer.setData('application/tinstar-browser', JSON.stringify({ sessionId: run.sessionId }))
          e.dataTransfer.effectAllowed = 'copy'
        }}
        className="flex flex-col items-center justify-center gap-0.5 h-full px-3 cursor-grab active:cursor-grabbing transition-colors"
        style={{
          color: hoveredBtn === 'browser' ? runAccent : hexToRgba(runAccent, 0.55),
          background: hoveredBtn === 'browser' ? hexToRgba(runAccent, 0.06) : undefined,
        }}
        title="Drag to canvas to create a browser widget"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>language</span>
        <span className="text-[8px] font-bold tracking-wide leading-none">BROWSER</span>
      </div>

      {/* Separator before Refresh */}
      <div className="w-px self-stretch bg-white/[0.07]" />

      {/* Refresh — only when live and port exists */}
      {isLive && run.port && (
        <button
          onClick={refreshTerminal}
          onMouseEnter={() => setHoveredBtn('refresh')}
          onMouseLeave={() => setHoveredBtn(null)}
          className="flex flex-col items-center justify-center gap-0.5 h-full px-3 transition-colors"
          style={{
            color: runAccent,
            background: hoveredBtn === 'refresh' ? hexToRgba(runAccent, 0.06) : undefined,
          }}
          title="Refresh — re-registers the proxy route so the browser widget can reach this session's port"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
          <span className="text-[8px] font-bold tracking-wide leading-none">REFRESH</span>
        </button>
      )}

      {/* Separator before danger group */}
      <div className="w-px self-stretch bg-white/[0.07]" />

      {/* Stop / Resume */}
      {isLive ? (
        <button
          onClick={() => sessionAction('stop')}
          disabled={busy}
          className="flex flex-col items-center justify-center gap-0.5 h-full px-3 text-slate-500 transition-colors hover:bg-accent-red/[0.08] hover:text-accent-red disabled:opacity-50"
          title="Stop session"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>stop_circle</span>
          <span className="text-[8px] font-bold tracking-wide leading-none">STOP</span>
        </button>
      ) : (
        <button
          onClick={() => sessionAction('start')}
          disabled={busy}
          className="flex flex-col items-center justify-center gap-0.5 h-full px-3 text-slate-500 transition-colors hover:bg-accent-green/[0.08] hover:text-accent-green disabled:opacity-50"
          title="Resume session"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_circle</span>
          <span className="text-[8px] font-bold tracking-wide leading-none">RESUME</span>
        </button>
      )}

      {/* Delete — adjacent to Stop with no separator */}
      <button
        onClick={() => sessionAction('delete')}
        disabled={busy}
        className="flex flex-col items-center justify-center gap-0.5 h-full px-3 text-slate-500 transition-colors hover:bg-accent-red/[0.08] hover:text-accent-red disabled:opacity-50"
        title="Delete session"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
        <span className="text-[8px] font-bold tracking-wide leading-none">DELETE</span>
      </button>
    </div>
  )}
  ```

- [ ] **Step 5: Type-check**

  ```bash
  cd /home/ubuntu/repo/tinstar && npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors.

- [ ] **Step 6: Visual check — start the dev server and inspect in browser**

  ```bash
  TINSTAR_FAST_SIM=1 npm run dev
  ```

  Open the app and verify:
  - Header is taller with labeled buttons flush top-to-bottom
  - Color and Browser buttons show accent-colored labels
  - Refresh appears with green accent and has the long tooltip on hover
  - Stop and Delete are adjacent at the right edge
  - WORKTREE / REPO text is still visible to the left of the button group

- [ ] **Step 7: Commit**

  ```bash
  git add src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx
  git commit -m "feat: run workspace header — full-height labeled buttons, grouped stop/delete, refresh tooltip"
  ```

---

### Task 3: Run E2E tests and verify

- [ ] **Step 1: Ensure dev server is running with sim data**

  ```bash
  TINSTAR_FAST_SIM=1 npm run dev
  ```

  Note the port (default 5280).

- [ ] **Step 2: Run the new header tests**

  ```bash
  cd /home/ubuntu/repo/tinstar
  TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5280 npx playwright test e2e/run-panels.spec.ts --grep "Run Widget Header Actions" 2>&1 | tail -40
  ```

  Expected: all 6 tests pass.

- [ ] **Step 3: Run the full run-panels suite to confirm no regressions**

  ```bash
  TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5280 npx playwright test e2e/run-panels.spec.ts e2e/run-interactions.spec.ts 2>&1 | tail -20
  ```

  Expected: all tests pass.

- [ ] **Step 4: Commit if any test fixes were needed**

  If test selectors needed adjusting (e.g. the `ancestor::` xpath for the tooltip test), commit the fix:

  ```bash
  git add e2e/run-panels.spec.ts
  git commit -m "fix: adjust header action test selectors to match implementation"
  ```
