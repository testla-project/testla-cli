// src/utils/plan_validator.ts

import type { AnalystPlan } from "../agents/analyst.ts";

export type PlanValidationResult =
  | { ok: true }
  | { ok: false; reason: PlanValidationFailureReason; details: string };

export enum PlanValidationFailureReason {
  ASSERT_IN_TASK             = "ASSERT_IN_TASK",
  UNASSIGNED_INTENTION       = "UNASSIGNED_INTENTION",
  DUPLICATE_INTENTION_INDEX  = "DUPLICATE_INTENTION_INDEX",
  DUPLICATE_ELEMENT_LABEL    = "DUPLICATE_ELEMENT_LABEL",
  MISSING_SCREEN_FOR_ASSERT  = "MISSING_SCREEN_FOR_ASSERT",
  MISSING_ASSERTION_KIND     = "MISSING_ASSERTION_KIND",
}

export function validatePlan(plan: AnalystPlan): PlanValidationResult {
  const allIndices    = plan.tasks.flatMap((t) => t.intentionIndices ?? []);
  const allLabels     = new Map<string, string>(); // label → screen name

  // ── Check 1: Kein Assert-Index in intentionIndices ─────────────────────────
  for (const task of plan.tasks) {
    for (const idx of task.intentionIndices ?? []) {
      const intention = plan.intentions[idx];
      if (intention?.action === "assert") {
        return {
          ok: false,
          reason: PlanValidationFailureReason.ASSERT_IN_TASK,
          details:
            `Task "${task.name}" enthält intentionIndex ${idx}, der auf einen Assert zeigt.\n` +
            `  → intentions[${idx}]: { action: "assert", target: "${intention.target}" }\n` +
            `  Assertions dürfen nie in Tasks sein (Rule 4). Korrekt wäre Index ${idx - 1} für den vorherigen Click.`,
        };
      }
    }
  }

  // ── Check 2: Jede interaktive Nicht-Assert-Intention ist genau einmal zugewiesen ──
  const interactiveIndices = plan.intentions
    .map((intention, i) => ({ intention, i }))
    .filter(({ intention }) => intention.action !== "navigate" && intention.action !== "assert")
    .map(({ i }) => i);

  const indexCount = new Map<number, number>();
  for (const idx of allIndices) {
    indexCount.set(idx, (indexCount.get(idx) ?? 0) + 1);
  }

  // Doppelt zugewiesene Indizes
  for (const [idx, count] of indexCount) {
    if (count > 1) {
      return {
        ok: false,
        reason: PlanValidationFailureReason.DUPLICATE_INTENTION_INDEX,
        details: `intentionIndex ${idx} ist in ${count} Tasks gleichzeitig zugewiesen.`,
      };
    }
  }

  // Nicht zugewiesene interaktive Intentions
  const unassigned = interactiveIndices.filter((i) => !indexCount.has(i));
  if (unassigned.length > 0) {
    const list = unassigned
      .map((i) => `  [${i}] ${plan.intentions[i].action} → "${plan.intentions[i].target}"`)
      .join("\n");
    return {
      ok: false,
      reason: PlanValidationFailureReason.UNASSIGNED_INTENTION,
      details:
        `${unassigned.length} interaktive Intention(en) sind keinem Task zugewiesen:\n${list}\n` +
        `Jede click/fill/type Intention muss in genau einem intentionIndices-Array erscheinen.`,
    };
  }

  // ── Check 3: Keine doppelten Element-Labels über Screens hinweg ────────────
  for (const screen of plan.screens) {
    for (const label of screen.elements) {
      const key = label.toLowerCase();
      if (allLabels.has(key)) {
        return {
          ok: false,
          reason: PlanValidationFailureReason.DUPLICATE_ELEMENT_LABEL,
          details:
            `Label "${label}" erscheint auf Screen "${allLabels.get(key)}" UND auf Screen "${screen.name}".\n` +
            `Jedes Label muss eindeutig sein. Benenne eines um, z.B. "Inputs link" vs "Inputs heading".`,
        };
      }
      allLabels.set(key, screen.name);
    }
  }

  // ── Check 4: Assert-Targets mit Screen gemappt (außer url-Assertions) ──────
  for (const intention of plan.intentions) {
    if (intention.action !== "assert") continue;
    if (intention.assertionKind === "url") continue;

    if (!allLabels.has(intention.target.toLowerCase())) {
      return {
        ok: false,
        reason: PlanValidationFailureReason.MISSING_SCREEN_FOR_ASSERT,
        details:
          `Assert-Target "${intention.target}" ist in keinem Screen definiert.\n` +
          `Wenn die Assertion auf einer zweiten Seite stattfindet, muss diese einen eigenen Screen-Eintrag haben.`,
      };
    }
  }

  // ── Check 5: Jeder Assert hat einen assertionKind ──────────────────────────
  for (const intention of plan.intentions) {
    if (intention.action !== "assert") continue;
    if (!intention.assertionKind) {
      return {
        ok: false,
        reason: PlanValidationFailureReason.MISSING_ASSERTION_KIND,
        details:
          `Assert-Intention "${intention.target}" hat kein assertionKind.\n` +
          `Erlaubte Werte: visible | enabled | checked | text | value | count | minCount | url`,
      };
    }
  }

  return { ok: true };
}