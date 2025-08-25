# Playwright Testing Guide

This guide explains how to run the Playwright test suite for the FileTree UI component and view the results.

## Prerequisites

Make sure you're in the correct directory and have dependencies installed:

```bash
cd ui
npm install
```

## Running Tests

### Basic Test Execution

```bash
# Run all tests
npm test

# Or use npx directly
npx playwright test
```

### Specific Test Categories

```bash
# Run only component tests
npx playwright test tests/components

# Run only utility tests
npx playwright test tests/utils

# Run only integration tests
npx playwright test tests/integration

# Run visual screenshot tests
npx playwright test tests/visual-screenshots.spec.ts
```

### Test Execution Options

```bash
# Run tests with different output formats
npx playwright test --reporter=list          # Detailed list format
npx playwright test --reporter=dot           # Minimal dot format
npx playwright test --reporter=json          # JSON output

# Run tests in different browsers
npx playwright test --project=chromium       # Chrome/Chromium only
npx playwright test --project=firefox        # Firefox only
npx playwright test --project=webkit         # Safari/WebKit only

# Run specific test files
npx playwright test tests/components/filelist/filetree.spec.ts
```

## Viewing Test Results

### HTML Report (Recommended)

The HTML report provides the best overview with interactive features:

```bash
# Open the HTML test report
npx playwright show-report
```

The HTML report includes:
- ✅ Test results with pass/fail status
- 📸 **Screenshots** for failed tests and visual tests
- 🕐 Test execution times and detailed logs
- 🔍 Interactive filtering and search
- 📋 Test code snippets and error details

### Screenshots and Visual Results

Screenshots are automatically saved in the `test-results/` directory:

```bash
# List all generated screenshots
ls test-results/*.png

# View specific screenshots
open test-results/filetree-full-component.png
open test-results/filetree-component-only.png
open test-results/file-hierarchy.png
```

### Console Output

For quick results, check the console output:

```bash
# Example successful run
Running 17 tests using 1 worker
✓ 17 passed (12.3s)

# Example with failures
Running 17 tests using 1 worker
✘ 2 failed
✓ 15 passed (15.7s)
```

## Interactive Testing Modes

### UI Mode (Visual Test Runner)

Launch the interactive Playwright UI for debugging:

```bash
npm run test:ui
# or
npx playwright test --ui
```

Features:
- 🎮 Interactive test selection and execution
- 👀 Real-time browser viewing
- 🔍 Step-by-step test debugging
- 📱 Device and browser switching
- ⏯️ Pause and resume test execution

### Debug Mode

Run tests in debug mode for detailed inspection:

```bash
npm run test:debug
# or
npx playwright test --debug
```

Debug features:
- 🛑 Automatic breakpoints on failures
- 🔍 Browser developer tools integration
- ⏯️ Step-through test execution
- 🎯 Element inspection and selection

## Test Output Files and Directories

```
ui/
├── test-results/           # Screenshots and failure artifacts
│   ├── *.png              # Test screenshots
│   ├── *-failed/          # Failure details and traces
│   └── trace.zip          # Execution traces
├── playwright-report/     # HTML report files
│   ├── index.html         # Main report page
│   └── data/             # Report assets
└── tests/                # Test source files
    ├── components/       # Component tests
    ├── utils/           # Utility tests
    └── integration/     # Integration tests
```

## Understanding Test Results

### Test Status Indicators

- ✅ **Passed** - Test completed successfully
- ❌ **Failed** - Test failed with assertion error
- ⚠️ **Flaky** - Test passed after retry
- ⏭️ **Skipped** - Test was skipped
- ⏸️ **Timeout** - Test exceeded time limit

### Reading Test Output

```bash
# Successful test output
✓ [chromium] › FileTree Component › renders basic file tree structure (628ms)

# Failed test output  
✘ [chromium] › FileTree Component › handles file clicks correctly (1.2s)
  Error: expect(locator).toBeVisible() failed
  Expected: visible
  Received: <element(s) not found>
```

### Screenshot Locations

Screenshots are saved with descriptive names:

```
test-results/
├── filetree-full-component.png           # Complete component view
├── filetree-component-only.png           # File tree section only
├── filetree-with-test-results.png        # Component with test output
├── file-hierarchy.png                    # File structure visualization
├── file-with-stats.png                   # Individual file with stats
├── edit-button.png                       # Edit button close-up
└── stats-display.png                     # Statistics formatting
```

## Troubleshooting

### Common Issues

**Tests timeout or hang:**
```bash
# Increase timeout
npx playwright test --timeout=60000
```

**Browser installation issues:**
```bash
# Reinstall Playwright browsers
npx playwright install
```

**Permission errors on screenshots:**
```bash
# Clean test results
rm -rf test-results/ playwright-report/
npx playwright test
```

### Debugging Failed Tests

1. **View the HTML report** for detailed failure information
2. **Check screenshots** in `test-results/` directory
3. **Run in debug mode** to step through the failing test:
   ```bash
   npx playwright test --debug tests/path/to/failing-test.spec.ts
   ```
4. **Use UI mode** for interactive debugging:
   ```bash
   npx playwright test --ui
   ```

### Performance Tips

```bash
# Run tests in parallel (faster)
npx playwright test --workers=4

# Run only specific browser for speed
npx playwright test --project=chromium

# Skip slow integration tests during development
npx playwright test tests/components tests/utils
```

## Continuous Integration

For CI/CD pipelines, use these commands:

```bash
# CI-friendly test execution
npx playwright test --reporter=github

# Generate reports for CI
npx playwright test --reporter=html,github

# Run with retries for flaky tests
npx playwright test --retries=2
```

## Visual Regression Testing

To enable visual comparison testing:

```bash
# Generate baseline screenshots
npx playwright test --update-snapshots

# Run visual comparison tests
npx playwright test tests/visual-screenshots.spec.ts
```

## Test Coverage Summary

The current test suite provides:

- **Component Tests**: 13 tests covering structure, interactions, and formatting
- **Utility Tests**: 2 tests validating mock data and specifications  
- **Visual Tests**: 4 tests generating screenshots for inspection
- **Integration Tests**: 3 tests for API interactions (may timeout without backend)

**Total: 22 tests with comprehensive coverage of the FileTree component**

For questions or issues with testing, refer to the [Playwright documentation](https://playwright.dev) or check the test files in the `tests/` directory.