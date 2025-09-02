# QA

## Overview

QA provides automated and AI-assisted quality assurance for agent-performed work. The system enables easy validation of agent changes through configurable test commands and intelligent QA recommendations. The primary goal is to answer the question: "Did the agent break anything?"

## Data Contracts

### Entities

- QAConfig
  - `test_command` (string, shell command to execute for testing)
  - `working_directory` (optional string, directory to run tests from; defaults to project root)

- QAResult  
  - `id` (string, UUID)
  - `project_name` (string, associated project)
  - `exit_code` (number, process exit code)
  - `stdout` (string, captured standard output)
  - `stderr` (string, captured standard error)
  - `started_at` (ISO 8601 timestamp)
  - `completed_at` (ISO 8601 timestamp)
  - `status` ("passed" | "failed")

- QAStatus
  - `project_name` (string, associated project)
  - `current_status` ("idle" | "running" | "passed" | "failed")
  - `last_run_at` (optional ISO 8601 timestamp)
  - `last_result_id` (optional string, UUID of most recent result)

- QAAdvice
  - `project_name` (string, associated project)
  - `response` (string, Claude's QA recommendations)
  - `created_at` (ISO 8601 timestamp)

### API (HTTP)

- GET `/api/projects/{name}/qa/config`
  - Response: `{ "config": QAConfig }`
  - Returns current QA configuration for project

- PUT `/api/projects/{name}/qa/config`
  - Body: `{ "test_command": string, "working_directory"?: string }`
  - Response: `{ "config": QAConfig }`
  - Updates QA configuration for project

- GET `/api/projects/{name}/qa/status`
  - Response: `{ "status": QAStatus }`
  - Returns current QA status (idle, running, passed, failed)

- POST `/api/projects/{name}/qa/test`
  - Response: `{ "result": QAResult }`
  - Executes configured test command and returns results

- GET `/api/projects/{name}/qa/results`
  - Query: `?limit=<number>`
  - Response: `{ "results": QAResult[] }`
  - Returns historical test results

- POST `/api/projects/{name}/qa/advice`
  - Response: `{ "advice": QAAdvice }`
  - Generates AI-powered QA recommendations

### CLI (Typer)

- `tinstar qa config <project_name> --command <test_command> [--workdir <path>]` - Configure QA for project
- `tinstar qa status <project_name>` - Check current QA status
- `tinstar qa test <project_name>` - Run QA tests for project
- `tinstar qa advice <project_name>` - Get AI QA recommendations
- `tinstar qa results <project_name> [--limit <number>]` - View test history

## Logic

### Configuration Management

- QA configuration is stored per-project in the projects database
- Default working directory is the project root path
- Simple configuration: just test command and optional working directory

### Status Tracking

- Track current status per project: idle, running, passed, failed
- Update status when tests start (running) and complete (passed/failed)
- Maintain reference to most recent test result

### Test Execution

1. **Command Execution**:
   - Change to configured working directory (or project root)
   - Execute test command using subprocess
   - Capture stdout, stderr, and exit code
   - Track execution timestamps

2. **Result Processing**:
   - Determine status: passed (exit code 0) or failed (non-zero exit code)
   - Store complete results in database for historical tracking
   - Update project QA status with latest result

### AI-Powered QA Advice

1. **Simple Claude Integration**:
   - Execute `claude --print` with canned prompt as non-interactive subprocess
   - Focus on manual QA steps beyond automated tests
   - Recommend UI testing, new feature validation, integration testing
   - Capture full response for display to user

### Storage

- SQLite database: `~/.tinstar/db/tinstar.db` (shared with other modules)
- Tables:
  - `qa_configs` (project_name, test_command, working_directory, updated_at)
  - `qa_results` (id, project_name, exit_code, stdout, stderr, started_at, completed_at, status)
  - `qa_status` (project_name, current_status, last_run_at, last_result_id)
  - `qa_advice` (project_name, response, created_at)

### Validation Rules

- Test commands must be non-empty strings
- Working directories must exist and be readable
- Project names must correspond to existing projects

### UI Integration

1. **Project Configuration**:
   - Add QA configuration section to project settings dialog
   - Include fields for test command and working directory

2. **Control Panel Integration**:
   - Add "Run Tests" button to execute QA tests
   - Add "Get QA Advice" button for AI recommendations  
   - Display current QA status (idle/running/passed/failed)
   - Show most recent test results inline

3. **Results Display**:
   - Show test execution status with visual indicators
   - Display exit codes and captured output
   - Provide historical test results view with pass/fail history

## Tests

- Configure QA for project
  - Given: valid project and test command
  - When: PUT `/api/projects/{name}/qa/config` with test configuration
  - Then: configuration stored; subsequent tests use new settings

- Check QA status
  - Given: project with no previous test runs
  - When: GET `/api/projects/{name}/qa/status`
  - Then: returns status="idle" with no last_run_at

- Execute successful test
  - Given: project with configured test command that exits 0
  - When: POST `/api/projects/{name}/qa/test`
  - Then: status updates to "running" then "passed"; stdout/stderr captured; result stored

- Execute failing test  
  - Given: project with test command that exits non-zero
  - When: test execution requested
  - Then: status updates to "running" then "failed"; exit code and output captured

- Generate QA advice
  - Given: project with configured tests
  - When: POST `/api/projects/{name}/qa/advice`
  - Then: Claude generates QA recommendations; response stored and returned

- Historical results retrieval
  - Given: project with multiple test executions over time
  - When: GET `/api/projects/{name}/qa/results?limit=5`
  - Then: returns 5 most recent results with pass/fail status and output

- Status persistence
  - Given: project with completed test (passed or failed)
  - When: GET `/api/projects/{name}/qa/status` called later
  - Then: returns last known status with timestamp and result reference

- Invalid configuration
  - Given: non-existent working directory
  - When: configuration update attempted
  - Then: validation fails with clear error message; existing config unchanged

- Missing project handling
  - Given: QA operation on non-existent project
  - When: any QA API call made
  - Then: returns 404 with appropriate error message

## Definition of Done

- QA configuration management implemented with simple per-project settings
- Test execution engine with subprocess management and output capture
- Status tracking system (idle, running, passed, failed) implemented
- AI-powered QA advice generation using Claude integration
- HTTP API endpoints for all QA operations implemented
- CLI commands for QA configuration, status checking, and execution implemented
- Database schema for storing configurations, results, status, and advice
- UI integration in project settings and control panel
- Historical test result storage and retrieval implemented
- Pass/fail history maintained over time with stdout/stderr capture
- Comprehensive error handling and validation implemented
- Tests cover all scenarios including failures and edge cases
- Integration with Projects module for configuration persistence