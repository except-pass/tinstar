# FileTree Component Test Suite

This test suite provides comprehensive coverage of the FileTree UI component and follows a scalable testing pattern that can be applied to other UI components in the project.

## Test Structure

```
tests/
├── components/           # Component-specific tests
│   └── filelist/
│       └── filetree.spec.ts    # FileTree component tests
├── utils/               # Test utilities and data validation  
│   └── test-data.spec.ts       # Mock data validation
├── integration/         # API and integration tests
│   └── api-integration.spec.ts # Backend API integration
└── README.md           # This file
```

## Test Categories

### 1. Component Tests (`components/filelist/filetree.spec.ts`)

Tests the FileTree React component in isolation:
- **Component Structure**: Rendering, CSS classes, DOM structure
- **Stats Formatting**: Display of file statistics according to spec
- **User Interactions**: File clicks, edit buttons, navigation
- **Quality Assurance**: Error handling, automated testing infrastructure

### 2. Test Data Validation (`utils/test-data.spec.ts`)

Validates mock data and test utilities:
- API specification compliance
- Coverage of all test scenarios
- Data structure consistency

### 3. Integration Tests (`integration/api-integration.spec.ts`)

Tests integration with backend APIs:
- API endpoint format verification
- Request/response validation  
- Error handling scenarios
- Editor integration

## Running Tests

### All Tests
```bash
cd ui
npm test
```

### Specific Test Categories
```bash
# Component tests only
npx playwright test tests/components

# Integration tests only  
npx playwright test tests/integration

# Specific test file
npx playwright test tests/components/filelist/filetree.spec.ts
```

### With UI Mode (for debugging)
```bash
npm run test:ui
```

### Debug Mode
```bash
npm run test:debug
```

## Test Data

The test suite uses mock data that follows the API specification:

```typescript
interface FileTreeResponse {
  tree: DirectoryNode
}

interface DirectoryNode {
  type: 'directory'
  path: string
  children: (FileNode | DirectoryNode)[]
  stats: Record<string, number>
}

interface FileNode {
  type: 'file'
  path: string
  size: number
  modified: string
  stats: {
    lines_added?: number
    lines_removed?: number
    is_tracked?: boolean
    binary?: boolean
  }
}
```

Mock data covers these scenarios:
- Files with added/removed lines
- New untracked files
- Binary files
- Empty directories
- Nested directory structures
- Various stats combinations

## Scalable Testing Pattern

This test suite establishes a pattern that can be replicated for other UI components:

### 1. Component Isolation
- Use HTML test harnesses for direct component testing
- Mock external dependencies (APIs, other components)
- Test component behavior in isolation

### 2. Progressive Testing
- Start with basic rendering tests
- Add interaction tests
- Include edge case and error scenarios

### 3. Test Organization
- Separate concerns: components, utilities, integration
- Use descriptive test names and group related tests
- Include comprehensive documentation

### 4. Quality Assurance
- Validate test data against specifications
- Include automated testing infrastructure tests
- Monitor for JavaScript errors and console warnings

## Applying to Other UI Components

To create tests for a new UI component following this pattern:

1. **Create component test file**:
   ```
   tests/components/[component-name]/[component].spec.ts
   ```

2. **Structure tests by concern**:
   ```typescript
   test.describe('Component Structure and Rendering', () => {
     // Basic rendering tests
   });
   
   test.describe('User Interactions', () => {
     // Click handlers, form inputs, etc.
   });
   
   test.describe('API Integration', () => {
     // External API calls, data flow
   });
   ```

3. **Create supporting files**:
   - Mock data files
   - Test utilities
   - HTML test harnesses if needed

4. **Add integration tests** if the component interacts with APIs

5. **Update this README** with component-specific testing notes

## Test Coverage

The current test suite covers:
- ✅ Component rendering and structure
- ✅ Stats formatting according to specification  
- ✅ File and directory display
- ✅ User interactions (file clicks, edit buttons)
- ✅ API integration points
- ✅ Error handling scenarios
- ✅ Test data validation
- ✅ Automated testing infrastructure

## Continuous Integration

These tests are designed to run in CI environments:
- Use headless browser mode by default
- Include proper timeouts and wait conditions
- Generate HTML reports for debugging
- Support multiple browser engines (Chromium, Firefox, WebKit)

## Performance Considerations

- Tests use mock data to avoid network dependencies
- HTML test harnesses minimize setup overhead
- Tests run in parallel where possible
- Proper cleanup between tests to prevent memory leaks