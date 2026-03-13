---
name: testing
description: E2E test writing and exploratory testing methodology for Tinstar
---

# Tinstar E2E Testing

## Philosophy

Tests verify **user-visible behavior**, not implementation details. A good test answers: "If a real user performed these actions, would the application behave correctly?"

## Running Tests

```bash
TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test
```

## Selectors (priority order)

1. `getByRole('button', { name: 'Save' })` — ARIA roles
2. `getByLabel('Project Name')` — accessible labels
3. `getByTestId('space-switcher')` — test IDs
4. `getByText('Saved successfully')` — visible text

Never rely on CSS hierarchy, element index, or auto-generated class names.

## Structure

Every test follows **Arrange → Act → Assert** and verifies one coherent behavior.

```ts
test('user can create a project', async ({ page }) => {
  await page.goto('/')                                          // Arrange
  await page.getByRole('button', { name: 'New' }).click()      // Act
  await expect(page.getByText('Test Project')).toBeVisible()    // Assert
})
```

## Rules

- **No fixed sleeps** — wait for state: `await expect(locator).toBeVisible()`
- **Independent tests** — no shared state, any execution order
- **Fixtures for setup** — `loginAsUser()`, `createProject()`, not repeated boilerplate
- **Unique test data** — `const name = \`test-\${Date.now()}\``
- **Real backend** — E2E tests use the simulator, not mocks
- **Verify persistence** — reload when appropriate to confirm state survived

## Exploratory Testing Methodology

When writing tests for a feature, go beyond the happy path:

### 1. Discover the surface area
- Main actions, secondary actions, editable fields, modals, lists, filters, destructive actions, loading/error states, drag/drop surfaces

### 2. Verify the happy path
- Complete the primary workflow, confirm visible outcome and persisted state

### 3. Attack the assumptions
- Empty, invalid, duplicate, boundary, and malformed input
- Click buttons twice quickly
- Interrupt flows with refresh, cancel, or navigation
- Test empty states, max states, single-item states, long-content states
- Probe for race conditions, stale UI, duplicate submissions

### 4. Watch for weak signals
- Duplicate toasts, stale data after save, stuck spinners
- Modals closing without persistence, duplicated rows
- State leakage between opens, lost selection
- Hidden errors with no user feedback

### 5. Convert findings into tests
- Prefer tests that catch serious bugs over trivial coverage
- Core workflows, destructive flows, important negative cases, regression risks

## Quality Checklist

Before finishing a test:
- Uses stable selectors (role > label > testid > text)
- No fixed sleeps
- Independent from other tests
- Tests user-visible behavior
- Clear assertions
- Easy to read in under 10 seconds
