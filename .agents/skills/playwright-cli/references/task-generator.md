# Generate Tasks (Business Logic)

In testla-screenplay-playwright, Tasks represent **business intent**.

Tasks bundle multiple Actions into a meaningful business flow that an Actor performs.

> **Core Principle**  
> Tasks describe business flow — never UI logic.  
> Tasks orchestrate Actions, but never define how elements are located.

Tasks must be completely independent from DOM structure and selector logic.

---

## Golden Rules

- Tasks may **only** reference selectors from Screen classes.
- Tasks must **never** contain selectors.
- Tasks must **never** contain UI logic.
- Tasks must **never** transform data for selectors.

---

## Structure of a Task

A Task must always follow this structure.

### 1. Private Constructor

The constructor is private to enforce instantiation through a static factory method.

### 2. `performAs`

This method defines the exact sequence of Actions the Actor performs.

> **Strict Rule**  
> `performAs` must contain exactly one `actor.attemptsTo(...)` call.  
> No control flow is allowed inside a Task (`if`, `for`, `while`, etc.).

Tasks are declarative descriptions of Actions — not program logic.

### 3. Static Factory Method (Mandatory)

A static factory method (e.g. `calculation(...)`) is required to create the Task instance.

> This is mandatory for correct Testla call stack initialization and reporting.

### 4. Fluent Interface Methods (Optional)

Fluent methods (e.g. `withWaitState(...)`) may be added.

> These methods exist **only** to enrich the Testla call stack for debugging and reporting.  
> They must use `addToCallStack`.

They must not introduce business logic.

---

## Example: `Request.ts`

```typescript
import { Actor, Task } from '@testla/screenplay-playwright';
import { Click, Navigate, Wait } from '@testla/screenplay-playwright/web';
import { CalculateScreen, DialogScreen, HomeScreen } from '../screens';

export class Request extends Task {
    private constructor(
        private kategorie: string,
        private verlauf: string,
        private anbieter: string
    ) {
        super();
    }

    public async performAs(actor: Actor): Promise<any> {
        return actor.attemptsTo(
            Navigate.to('/'),
            Wait.forLoadState('networkidle'),

            Click.on(HomeScreen.ACCEPT_COOKIE_BUTTON),

            // Example: iFrame usage
            Click.on(HomeScreen.CALCULATE_BUTTON)
                .inFrame(HomeScreen.PARTNER_PORTAL_IFRAME),

            Wait.forLoadState('networkidle'),

            // Example: text-based filtering
            Click.on(CalculateScreen.PRODUKTFILTER_BUTTON, { hasText: this.kategorie }),
            Click.on(CalculateScreen.PRODUKTFILTER_BUTTON, { hasText: this.verlauf }),

            // Example: SubSelector usage
            Click.on(CalculateScreen.PRODUKT_LIST_PRODUKT_CARD, {
                hasText: this.anbieter,
                subSelector: [CalculateScreen.PRODUKT_BERECHNEN_BUTTON]
            }),

            Click.on(DialogScreen.SUBMIT_ACTION),

            Wait.forLoadState('networkidle'),
        );
    }

    public static calculation(
        kategorie: string,
        verlauf: string,
        anbieter: string
    ): Request {
        const instance = new Request(kategorie, verlauf, anbieter);

        // Mandatory for Testla debugging / reporting
        instance.setCallStackInitializeCalledWith({
            kategorie,
            verlauf,
            anbieter
        });

        return instance;
    }

    public withWaitState(state: string): Request {
        this.addToCallStack({
            caller: 'withWaitState',
            calledWith: { state },
        });
        return this;
    }
}
```

## 5. Bundling Pattern (Index Pattern)

All Tasks must be exported via an index.ts inside the tasks directory.

Example: tasks/index.ts

```typescript
import { Request } from './request';
import { RiskProduct } from './risk_product';

export {
    Request,
    RiskProduct
};
```

## 6. Mental Model

Screens know where.
Tasks know what.
Actions know how.