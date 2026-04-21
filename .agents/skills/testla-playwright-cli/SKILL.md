---
name: testla-playwright-cli
description: Automate browser interactions using Testla-Screenplay-Playwright. Use when users ask to test web applications, create Screenplay-style test scenarios, or perform browser automation within the Testla framework.
---

# Browser Automation with Testla-Screenplay-Playwright

## Overview

This skill allows you to automate browser interactions using the Testla-Screenplay-Playwright framework. It maps standard browser interactions to Screenplay patterns.

## Non-negotiable Rules

- Use `npx playwright ...` or appropriate `testla` CLI commands as required by the project setup.
- Follow the Screenplay pattern: use Actors, Abilities (BrowseTheWeb), and Tasks/Interactions.
- If the user asks to generate a test, create a Testla-Screenplay compatible spec file.
- When elements are needed, use Testla-friendly locators (e.g., `By.testId`).

## Quick Start

```bash
# Example of a Testla-Screenplay actor setup in a test
import { Actor } from '@testla/screenplay';
import { BrowseTheWeb } from '@testla/screenplay-playwright';
import { Page } from '@playwright/test';

const actor = Actor.named('Alice').whoCan(BrowseTheWeb.using(page));

# Perform an action
await actor.attemptsTo(Navigate.to('https://playwright.dev'));
```

## Supported Actions (Screenplay)

- **Navigate**: `Navigate.to(url)`
- **Click**: `Click.on(target)`
- **Fill**: `Fill.in(target, text)`
- **Wait**: `Wait.forLoadState(...)`
