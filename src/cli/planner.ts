// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/cli/planner.ts
//
// Asks the LLM ONE question: given the page elements and the task description,
// return structured JSON describing what actions to perform and what to assert.
//
// The LLM never touches file paths, project dirs, or URLs.
// It only reasons about user interactions and assertions.
// ─────────────────────────────────────────────────────────────────────────────

import type { LLMProvider } from '../llm/types.ts';

export interface TaskAction {
    /** e.g. "Navigate", "Fill", "Click", "Wait" */
    action: string;
    /** prop name from Screen, e.g. "USERNAME_INPUT" */
    target?: string;
    /** value for Fill actions */
    value?: string;
}

export interface TestPlan {
    /** PascalCase name for the Screen class, e.g. "LoginScreen" */
    screenName: string;
    /** PascalCase name for the Task class, e.g. "LoginTask" */
    taskName: string;
    /** PascalCase name for the Question class, e.g. "IsLoginSuccessful" */
    questionName: string;
    /** Human-readable describe label */
    describeLabel: string;
    /** Ordered list of actions for the Task */
    actions: TaskAction[];
    /** What the Question checks — plain description */
    assertionDescription: string;
    /** The prop name from the Screen to assert on, e.g. "FLASH_MESSAGE_OUTPUT" */
    assertionTarget?: string;
    /** Playwright assertion expression using the assertionTarget locator */
    assertionExpression?: string;
}

const PLANNER_SYSTEM = `You are a test planning assistant for Playwright + testla-screenplay.

Given:
- A task description with numbered steps
- A list of discovered page elements with their Playwright locators

Return ONLY a JSON object (no markdown, no explanation) with this exact shape:
{
  "screenName": "LoginScreen",
  "taskName": "LoginTask",
  "questionName": "IsLoginSuccessful",
  "describeLabel": "Login at the-internet",
  "actions": [
    { "action": "Navigate" },
    { "action": "Fill", "target": "USERNAME_INPUT", "value": "tomsmith" },
    { "action": "Fill", "target": "PASSWORD_INPUT", "value": "SuperSecretPassword!" },
    { "action": "Click", "target": "LOGIN_BUTTON" }
  ],
  "assertionDescription": "Checks if the success flash message is visible",
  "assertionTarget": "FLASH_MESSAGE_OUTPUT",
  "assertionExpression": "return page.locator('#flash.success').isVisible();"
}

Rules:
- actions MUST follow the order from the task description exactly
- Navigate is always first, no target needed
- Fill actions use target (element prop name) and value (the actual text to type)
- Click actions use target only
- Use ONLY element propNames from the provided discovered elements
- assertionTarget must be an output element from the discovered list
- assertionExpression must use: const page = BrowseTheWeb.as(actor).getPage();`;

export async function planFromDiscovery(
    provider: LLMProvider,
    task: string,
    url: string,
    featureName: string,
    discoveryReport: string,
): Promise<TestPlan | null> {
    const userMessage =
        `Task description:\n${task}\n\n` +
        `Base URL: ${url}\n` +
        `Feature name: ${featureName}\n\n` +
        `Discovered page elements:\n${discoveryReport}\n\n` +
        `Return the JSON test plan.`;

    let response;
    try {
        response = await provider.chat(
            [
                { role: 'system', content: PLANNER_SYSTEM },
                { role: 'user', content: userMessage },
            ],
            [], // no tools — pure text response
        );
    } catch (err) {
        console.error('Planner LLM call failed:', err);
        return null;
    }

    const raw = (response.content ?? '').trim();

    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    try {
        return JSON.parse(cleaned) as TestPlan;
    } catch {
        console.error('Planner returned invalid JSON:', cleaned.slice(0, 300));
        return null;
    }
}