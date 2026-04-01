# Pattern Templates

Copy patterns to `~/.config/tinstar/patterns/` to make them available in Tinstar.

## Installation

```bash
mkdir -p ~/.config/tinstar/patterns
cp examples/patterns/*.md ~/.config/tinstar/patterns/
```

## Available Patterns

### bug-review

Worker investigates bug, orchestrator reviews with /proveit discipline.

- **Orchestrator**: Reviews worker's findings, enforces evidence requirements
- **Worker**: Investigates using /bugsearcher, submits findings for review
