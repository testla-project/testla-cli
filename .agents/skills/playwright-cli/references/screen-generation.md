# Generate Screens & Selector Strategy (Page Objects)

In testla-screenplay-playwright, Screens are the single source of truth for all selectors.

**Golden Rule**  
Tasks and Interactions must NEVER contain selectors.  
All selectors live exclusively inside Screen classes.

Screens exist to fully encapsulate DOM knowledge from the rest of the test code.

---

## 1. Selector Prioritization (Strict Order)

Selectors MUST be searched and applied in this exact order:

| Priority | Type | Example | Reason |
|---|---|---|---|
| **1** | **ID** | `#submit-button` | Unique, fastest, most stable |
| **2** | **Test-ID** | `[data-test="login-btn"]` | Designed for testing, UI-independent |
| **3** | **Playwright Locators** | `getByRole('button', { name: 'Login' })` | Based on UI semantics & accessibility tree, very stable |
| **4** | **CSS Selector** | `.login-form button` | Only if nothing else is possible |

> ❗ CSS is a last resort.  
> Prefer user-visible and semantic selectors over technical DOM structure.

This follows the official recommendations of :contentReference[oaicite:0]{index=0}.

### Test-ID Definition

Test-ID refers to attributes like `data-test`, `data-testid`, `data-test-id`, `data-qa`, or similar attributes explicitly introduced for testing.

### Locator Preference Rule

When using Playwright Locators, prefer `getByRole` over `getByText` whenever possible.

---

## 2. Static Selectors vs. LazySelector

There are only two allowed selector representations in Screens.

### ✅ Static string selector

Used when the selector can be expressed without Playwright API.

A selector is considered static if it can be written as a plain CSS string **without using `page.`**.

Examples:

- ID
- Test-ID
- Simple CSS

```ts
static SUBMIT_BUTTON = '#main-submit';
static FILTER_GROUP = '[data-test="product-filter"]';
static PRODUCT_CARD = '.product-card.active';

✅ LazySelector

Used when a Playwright Locator is required.

Hard Rule
If the selector cannot be expressed as a static string, it MUST be a LazySelector.

Type:

```typescript
import { LazySelector } from "@testla/screenplay-playwright/web/types";

static SAVE_BUTTON: LazySelector = (page) =>
    page.getByRole('button', { name: 'Speichern' });

static TARIFIERUNGS_DATEN: LazySelector = (page) =>
    page.getByRole('heading', { name: 'Tarifierungsdaten' });

static EMAIL_INPUT: LazySelector = (page) =>
    page.getByLabel('E-Mail');
```

## 3. What must NEVER happen

❌ No selectors inside Tasks
❌ No selectors inside Interactions
❌ No XPath
❌ No complex CSS chains when a locator is possible
❌ No mixing of CSS and Playwright Locators in one selector
❌ No positional CSS (:nth-child, deep chains, > combinations)

## 4. How an Agent must choose a selector

When generating a Screen selector, the agent MUST:

Inspect the element for an id attribute.
If not present → inspect for a Test-ID attribute.
If not present → use a semantic Playwright locator (getByRole, getByLabel, getByText, etc.).
Only if none of the above is possible → use CSS.

## 5. Naming Conventions (Important for Maintainability)
Use UPPER_SNAKE_CASE
Name by what the user sees, not by technical structure

✅ LOGIN_BUTTON
❌ BLUE_BUTTON_RIGHT

✅ EMAIL_INPUT
❌ INPUT_1

## 6. Example Screen
```typescript
import { LazySelector } from "@testla/screenplay-playwright/web/types";

export class CalculateScreen {
    // Priority 1 & 2: ID and Test-ID
    static SUBMIT_BUTTON = '#main-submit';
    static PRODUCT_FILTER = '[data-test="product-filter"]';

    // Priority 3: Playwright Locator via LazySelector
    static SAVE_BUTTON: LazySelector = (page) =>
        page.getByRole('button', { name: 'Speichern' });

    static EMAIL_INPUT: LazySelector = (page) =>
        page.getByLabel('E-Mail');

    // Priority 4: CSS (last resort)
    static ACTIVE_PRODUCT_CARD = '.product-card.active';
}
```

## 7. Bundling Pattern (Index Pattern)

All Screens must be exported via an index.ts inside the screens directory.

Example: screens/index.ts

```typescript
import { CalculateScreen } from './calculate';
import { DialogScreen } from './dialog';
import { HomeScreen } from './home';
import { RiskScreen } from './risk';

export {
    HomeScreen,
    CalculateScreen,
    DialogScreen,
    RiskScreen
};
```

## 8. Mental Model

Screens describe the UI as the user perceives it.
Not as the DOM is implemented.