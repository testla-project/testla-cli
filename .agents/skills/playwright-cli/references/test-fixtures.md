# Test Fixtures & Actors Reference

In testla-screenplay-playwright, tests are structured using Playwright fixtures.  
This allows creating isolated Actors (e.g. user roles) with specific Abilities and injecting them directly into tests.

Actors are the entry point for all Tasks and Interactions.

---

## Golden Rules

- Tests must never create Actors manually.
- Actors must always be created via fixtures.
- All Abilities must be assigned during fixture setup.
- Credentials and environment data must be injected via fixtures.
- Tests should only consume ready-to-use Actors.

## Core Principle

> Fixtures are responsible for creating fully configured Actors.  
> Tests must never manually create Actors.

This guarantees consistent Abilities, credentials, and environment setup across all tests.

---

## 1. Defining Actor Fixtures (`fixtures/actors.ts`)

Actors are defined using `test.extend()` and are equipped with Abilities such as `BrowseTheWeb` or `UseAPI`.

A factory function is recommended to standardize Actor creation.

```typescript
import { APIRequestContext, BrowserContext, test as base } from '@playwright/test';
import { Actor } from '@testla/screenplay-playwright';
import { BrowseTheWeb } from '@testla/screenplay-playwright/web';
import { UseAPI } from '@testla/screenplay-playwright/api';

// Factory function for creating a fully configured Actor
const createUser = async (
    context: BrowserContext,
    request: APIRequestContext,
    actorName: string,
    username: string,
    password: string
): Promise<Actor> => {
    const page = await context.newPage();

    return Actor.named(actorName)
        .with('username', username)
        .with('password', password)
        .can(BrowseTheWeb.using(page))
        .can(UseAPI.using(request));
};
```

## 2. Typing Available Actors

Define a type describing all available Actors.
This enables strong typing and auto-completion in tests.

```typescript
type Actors = {
    Bob: Actor;
    Alice: Actor;
};
```

## 3. Initializing Fixtures

Each Actor is initialized inside test.extend and provided to the test via the use callback.

```typescript
export const test = base.extend<Actors>({
    Bob: async ({ context, request }, use) => {
        const Bob = await createUser(
            context,
            request,
            'Bob',
            `${process.env.BOB_USER_NAME}`,
            `${process.env.BOB_USER_PASSWORD}`
        );

        await use(Bob);
    },

    Alice: async ({ context, request }, use) => {
        const Alice = await createUser(
            context,
            request,
            'Alice',
            `${process.env.ALICE_USER_NAME}`,
            `${process.env.ALICE_USER_PASSWORD}`
        );

        await use(Alice);
    },
});
```

## 4. Re-export expect

Re-export Playwright’s expect to ensure a single import source in tests.

```typescript
export { expect } from '@playwright/test';
```

## 5. Mental Model

Fixtures create Actors.
Actors perform Tasks.
Tasks use Screens.
Screens define selectors.