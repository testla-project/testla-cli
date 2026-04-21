---
name: testla-screenplay-playwright
description: End-to-End Testing Skill using the Testla Screenplay Pattern. Uses Playwright-CLI for selector discovery and generates Screens, Tasks, Actor Fixtures, and Persona-based Tests with strict architectural separation.
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*) Bash(mkdir:*) Bash(ls:*) Bash(cat:*) Bash(printf:*)
---

# Testla Screenplay Automation Skill

## Architecture Rules (MUST be followed)

1. Selectors exist ONLY inside Screen classes.
2. Tasks contain ONLY business flow, never selector logic.
3. Tests never create Actors manually — Actors come from fixtures.
4. Credentials are NEVER hardcoded — they come from `.env`.
5. All generated files MUST follow the defined project structure.

> Mental Model  
> Fixtures → Actors → Tasks → Screens → Selectors

---

## Project Structure (MUST be respected)

```text
src/
├── fixtures/
│   └── user.ts
├── screenplay/
│   ├── screens/
│   │   └── index.ts
│   └── tasks/
│       └── index.ts
tests/
└── *.spec.ts
```

## Execution Workflow
* **Inspect the UI
Use playwright-cli open <url> and snapshot to discover stable selectors.**
* **Create or update Screens
Store all selectors in src/screenplay/screens/ following the Screen reference.**
* **Create or update Tasks
Implement business flows in src/screenplay/tasks/ following the Task reference.**
* **Configure Personas
Add credentials to .env and register the Actor in src/fixtures/user.ts.**
* **Write the Test Spec
Create .spec.ts files where Actors perform Tasks and ask Questions.**

## Mandatory References

The following reference files define the exact implementation rules and MUST be followed:

* **Selector Discovery
references/playwright-cli.md**
* **Screen Classes
references/screen-generation.md**
* **Task Classes
references/task-generation.md**
* **Environment & Personas
references/environment-management.md**
* **Writing Tests
references/test-generation.md**