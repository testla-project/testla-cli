import { logger } from "../utils/logger.ts";
import { type TestlaConfig } from "../config/config.ts";
import { toonDeserialize, type ToonEnvelope } from "../utils/toon.ts";

// ─── Types ────────────────────────────────────────────────────

export type ToonIntention = {
  action: 'navigate' | 'click' | 'fill' | 'assert';
  target: string;
  value?: string;
};

export type ToonSpec = {
  personas: string[];
  screens: {
    name: string;
    elements: string[];
  }[];
  tasks: {
    name: string;
    flow: string[];
    intentionIndices?: number[];  // ← NEU: 0-basierte Indizes in plan.intentions[] 
  }[];
  test: {
    name: string;
    persona: string;
    taskFlow: string[];
    assertions: string[];
  };
  intentions: ToonIntention[];
};

export type AnalystPlan = ToonSpec;

// ─── LLM Call ─────────────────────────────────────────────────

async function callLlm(
  config: TestlaConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const url = `${config.ollama.baseUrl}/api/chat`;

  const body = {
    model: config.ollama.model,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Analyst: Ollama HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.message?.content ?? "";
}

// ─── System Prompt ────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a Screenplay Test Analyst.
You must output a TOON PLAN. NOT a response.

Structure:
[TOON:plan]
from: llm
to: analyst
---
{
  "personas": string[],
  "screens": [{ "name": string, "elements": string[] }],
  "tasks": [{ "name": string, "flow": string[], "intentionIndices": number[] }],
  "test": {
    "name": string,
    "persona": string,
    "taskFlow": string[],
    "assertions": string[]
  },
  "intentions": [
    { "action": "navigate", "target": "<full url>" },
    { "action": "click",    "target": "<human-readable element name>" },
    { "action": "fill",     "target": "<human-readable element name>", "value": "<text>" },
    { "action": "assert",   "target": "<human-readable element name>" }
  ]
}
[/TOON]

Rules for structuring the plan:

1. INTENTIONS (Critical baseline rules)
   - ALWAYS start the intentions array with a "navigate" action.
   - "target" must be a human-readable description of the element, NOT a CSS selector.
   - Do NOT add snapshot actions. The Explorer handles snapshots implicitly between every action.
   - Two elements that serve different purposes MUST have distinct labels, even if their
     visible text looks similar. Example: a link labelled "Inputs" and a heading labelled
     "Inputs" on the next page MUST be named differently — e.g. "Inputs link" vs
     "Inputs heading".

2. SCREEN & ELEMENT MAPPING
   - Plan your screens FIRST, then write your intentions.
   - Create one screen entry per page the test visits. If the test navigates to a second
     page, that page needs its own screen with its own elements.
   - Every "target" used in intentions (except "navigate") MUST be defined in
     screens[].elements on the screen where that action physically takes place.
   - If an action happens on a page that has no screen entry yet, you MUST create
     that screen first and add the element there.
   - The same label MUST NOT appear on two different screens.

3. THE NAVIGATION STRATEGY
   - Decide if a "navigate" action belongs to a Task or the Test:
     - ASSIGN TO TASK: If the navigation is a mandatory part of a workflow
       (e.g., navigating to /login for a "Login" task), include its index in
       the task's "intentionIndices".
     - LEAVE FOR TEST: If the navigation is just the initial entry point for
       the test, do NOT include its index in any task's "intentionIndices".
       The CodeWriter will then place it directly in the test body as page.goto().

4. THE ASSERTION RULE
   - Actions of type "assert" MUST NEVER be part of a task.
   - Do NOT include assert indices in any "intentionIndices".
   - Assertions belong in the test body only and are listed in test.assertions.

5. TASK INTENTION COVERAGE (CRITICAL — count carefully)
   Before writing intentionIndices, number EVERY intention in order:
     0: navigate (never in intentionIndices)
     1: first interactive action  ← first possible intentionIndex
     2: second interactive action
     ...
   - intentionIndices uses these exact 0-based positions.
   - assert indices are ALWAYS excluded (Rule 4).
   - If your only interactive non-assert action is at position 1,
     then intentionIndices MUST be [1]. Not [2]. Not [0]. [1].
   - "intentionIndices" uses 0-based indices into the top-level "intentions" array.
     Index 0 is always the navigate. Index 1 is the first interactive action. Count carefully.
   - Every interactive intention (click, fill, type, etc.) MUST be covered by exactly
     one task's "intentionIndices". No intention may appear in two tasks, and no
     interactive intention may be left unassigned.
   - Because of Rule 4, assert indices will NEVER appear in intentionIndices.
     If your only remaining interactive intention is a click at index 1,
     then intentionIndices MUST be [1].
   - The CodeWriter uses "intentionIndices" to build each Task's performAs() method.

6. ACTOR FIXTURES
   - The "persona" in the "test" object must be one of the strings defined in "personas".
   - Use realistic persona names like "Paul Private" or "Edgar Extrem".
`;

// const SYSTEM_PROMPT = `
// You are a Screenplay Test Analyst.

// You must output a TOON PLAN.

// NOT a response.

// Structure:

// [TOON:plan]
// from: llm
// to: analyst
// ---
// {
//   "personas": string[],
//   "screens": [{ "name": string, "elements": string[] }],
//   "tasks": [{ "name": string, "flow": string[] }],
//   "test": {
//     "name": string,
//     "persona": string,
//     "taskFlow": string[],
//     "assertions": string[]
//   },
//   "intentions": [
//     { "action": "navigate", "target": "<full url>" },
//     { "action": "click",    "target": "<human-readable element name>" },
//     { "action": "fill",     "target": "<human-readable element name>", "value": "<text>" },
//     { "action": "assert",   "target": "<human-readable element name>" }
//   ]
// }
// [/TOON]

// Rules for intentions:
// - "target" must be a human-readable description of the element, NOT a CSS selector
// - Always start with a navigate intention
// - Add a snapshot implicitly between every action (the Explorer handles this)
// - Every target used in intentions MUST appear verbatim in exactly one entry of screens[].elements. Labels are case-insensitive but must otherwise match exactly.
// - For each task in tasks[], add "intentionIndices": an array of 0-based indices into the top-level "intentions" array. Include all intentions (including navigate) that logically
// belong to this task. Navigate intentions are excluded by the CodeWriter automatically.
// Together, all intentionIndices arrays must cover every intention exactly once.
// `;

// ─── Analyst Entry ────────────────────────────────────────────

export async function analystAgent(
  prompt: string,
  startUrl: string,
  config: TestlaConfig,
): Promise<AnalystPlan> {
  const userMessage = `Goal: ${prompt}\nBaseURL: ${startUrl}`;
  const content = await callLlm(config, SYSTEM_PROMPT, userMessage);

  const envelope: ToonEnvelope<ToonSpec> = toonDeserialize(content);

  if (envelope.type !== "plan") {
    throw new Error(
      `Analyst: Expected TOON:plan but got TOON:${envelope.type}`
    );
  }

  const toon = envelope.payload;

  if (!toon.personas || !toon.screens || !toon.tasks || !toon.test || !toon.intentions) {
    throw new Error("Analyst: Invalid ToonSpec payload");
  }

  logger.info("Analyst", "TOON plan generated successfully.");

  return toon;
}