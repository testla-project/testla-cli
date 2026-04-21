// src/utils/validator.ts
//
// The Guard. Sits between Explorer output and CodeWriter input.
// If this returns false, the Orchestrator MUST abort — no exceptions.
//
// Responsibility: ensure that plan.intentions and actions.json are
// in perfect 1:1 alignment BEFORE the index-based zip in
// buildResolvedElements() ever runs.

import type { AnalystPlan } from "../agents/analyst.ts";
import type { ExecutedAction } from "../agents/playwright_cli.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: ValidationFailureReason; details: string };

export enum ValidationFailureReason {
  LENGTH_MISMATCH    = "LENGTH_MISMATCH",
  UNRESOLVED_LOCATOR = "UNRESOLVED_LOCATOR",
  MISSING_REF        = "MISSING_REF",
  UNKNOWN_ACTION_KIND = "UNKNOWN_ACTION_KIND",
  MISSING_SCREEN_MAPPING = "MISSING_SCREEN_MAPPING",
}

interface Logger {
  info(tag: string, msg: string): void;
  error(tag: string, msg: string): void;
  warn(tag: string, msg: string): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INTERACTIVE_INTENTION_KINDS = new Set(["click", "assert", "fill"]);
const INTERACTIVE_ACTION_KINDS    = new Set(["click", "assert", "fill"]);
const UNRESOLVED_MARKERS          = ["UNKNOWN", "UNRESOLVED", "unnamed"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isLocatorUnresolved(locatorCode: string): boolean {
  return UNRESOLVED_MARKERS.some((marker) => locatorCode.includes(marker));
}

function filterInteractiveIntentions(plan: AnalystPlan) {
  return plan.intentions.filter((i) => INTERACTIVE_INTENTION_KINDS.has(i.action));
}

function filterInteractiveActions(actions: ExecutedAction[]) {
  return actions.filter(
    (a) => a.kind !== "navigate" && a.kind !== "snapshot",
  );
}

// ─── Core Validation ──────────────────────────────────────────────────────────

/**
 * Validates that the Explorer output aligns with the Analyst plan.
 *
 * Checks (in order — fail fast on first violation):
 *  1. No unknown action kinds from the Explorer
 *  2. Interactive array lengths match (1:1 precondition for CodeWriter zip)
 *  3. Every interactive action has a non-empty locatorCode
 *  4. No locatorCode contains unresolved/unnamed markers
 *  5. Every interactive action has a ref (DOM anchor from Explorer)
 *
 * Returns a typed ValidationResult — callers decide what to do with it.
 */
export function validateExecution(
  plan: AnalystPlan,
  actions: ExecutedAction[],
): ValidationResult {
  const interactiveIntentions = filterInteractiveIntentions(plan);
  const interactiveActions    = filterInteractiveActions(actions);

  // ── Check 1: No unknown action kinds ──────────────────────────────────────
  for (const action of actions) {
    const known = new Set(["navigate", "snapshot", "click", "assert", "fill"]);
    if (!known.has(action.kind)) {
      return {
        ok: false,
        reason: ValidationFailureReason.UNKNOWN_ACTION_KIND,
        details:
          `Explorer produced unknown action kind "${action.kind}". ` +
          `Expected one of: ${[...known].join(", ")}.`,
      };
    }
  }

  // ── Check 2: Length alignment ──────────────────────────────────────────────
  if (interactiveIntentions.length !== interactiveActions.length) {
    const intentionList = interactiveIntentions
      .map((i, n) => `  [${n}] ${i.action} → "${i.target}"`)
      .join("\n");
    const actionList = interactiveActions
      .map((a, n) => `  [${n}] ${a.kind} (ref: ${a.ref ?? "—"})`)
      .join("\n");

    return {
      ok: false,
      reason: ValidationFailureReason.LENGTH_MISMATCH,
      details:
        `Plan has ${interactiveIntentions.length} interactive intention(s), ` +
        `but Explorer recorded ${interactiveActions.length} interactive action(s).\n` +
        `\nIntentions:\n${intentionList}\n` +
        `\nActions:\n${actionList}`,
    };
  }

    // ── Check 2b: Every interactive intention target is mapped in plan.screens ──
    const elementToScreens = new Map<string, string[]>();
    for (const screen of plan.screens ?? []) {
    for (const label of screen.elements ?? []) {
        const key = label.toLowerCase();
        const existing = elementToScreens.get(key) ?? [];
        existing.push(screen.name);
        elementToScreens.set(key, existing);
    }
    }

    const unmapped: string[] = [];
    for (const intention of interactiveIntentions) {
    if (!elementToScreens.has(intention.target.toLowerCase())) {
        unmapped.push(`  "${intention.target}" (${intention.action})`);
    }
    }

    if (unmapped.length > 0) {
    return {
        ok: false,
        reason: ValidationFailureReason.MISSING_SCREEN_MAPPING,
        details:
        `${unmapped.length} intention target(s) have no entry in plan.screens:\n` +
        unmapped.join("\n") + "\n\n" +
        `The CodeWriter fallback would silently assign these to ` +
        `The CodeWriter fallback would silently assign these to the last screen in the plan — ` +
        `fix the Analyst plan instead.`,
    };
    }

  // ── Checks 3 + 4 + 5: Per-action quality ─────────────────────────────────
  for (let i = 0; i < interactiveActions.length; i++) {
    const action    = interactiveActions[i];
    const intention = interactiveIntentions[i];
    const pos       = `[${i}] ${intention.action} → "${intention.target}"`;

    // 3. locatorCode must exist and be non-empty
    if (!action.locatorCode || action.locatorCode.trim() === "") {
      return {
        ok: false,
        reason: ValidationFailureReason.UNRESOLVED_LOCATOR,
        details: `${pos}: locatorCode is missing or empty.`,
      };
    }

    // 4. locatorCode must not contain unresolved/unnamed markers
    if (isLocatorUnresolved(action.locatorCode)) {
      return {
        ok: false,
        reason: ValidationFailureReason.UNRESOLVED_LOCATOR,
        details:
          `${pos}: locatorCode contains an unresolved marker.\n` +
          `  Got: ${action.locatorCode}\n` +
          `  Markers that trigger this: ${UNRESOLVED_MARKERS.join(", ")}`,
      };
    }

    // 5. ref must be present (proves the Explorer actually found the element)
    if (!action.ref) {
      return {
        ok: false,
        reason: ValidationFailureReason.MISSING_REF,
        details:
          `${pos}: action has no ref. ` +
          `The Explorer may have generated a locator speculatively without ` +
          `actually resolving it in the DOM.`,
      };
    }
  }

  return { ok: true };
}

// ─── Logging Helper ───────────────────────────────────────────────────────────

/**
 * Logs a ValidationResult in a human-readable format.
 * Call this in the Orchestrator immediately after validateExecution().
 */
export function logValidationResult(
  result: ValidationResult,
  logger: Logger,
): void {
  if (result.ok) {
    logger.info("Guard", "✅ Validation passed — Explorer output is aligned with plan.");
    return;
  }

  logger.error("Guard", `❌ Validation FAILED [${result.reason}]`);

  // Print each line of the details block individually so log output
  // stays readable in terminals that don't handle multi-line strings well.
  for (const line of result.details.split("\n")) {
    if (line.trim()) logger.error("Guard", `   ${line}`);
  }

  logger.error("Guard", "   → CodeWriter will NOT run. Fix the Explorer output and retry.");
}