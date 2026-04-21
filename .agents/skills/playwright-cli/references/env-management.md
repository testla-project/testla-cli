# Environment & Persona Configuration

## Golden Rules

- Credentials must NEVER be hardcoded in tests, Tasks, Screens, or fixtures.
- All persona credentials must be stored in a `.env` file in the project root.
- Every new Actor (persona) requires synchronized changes in:
  1. The `.env` file
  2. The Actor fixtures file (`src/fixtures/user.ts`)
- Fixtures must load credentials exclusively via `process.env`.

---

## Core Principle

> Environment configuration defines **who** the Actor is.  
> Fixtures define **how** the Actor is created.

This separation guarantees security, flexibility, and maintainability.

---

## 1. The `.env` File

Each Actor requires corresponding entries in the `.env` file located in the project root.

**Format**

```env
BOB_USER_NAME=bob_admin
BOB_USER_PASSWORD=geheim123

EDGAR_EXTREM_USER_NAME=edgar_pro
EDGAR_EXTREM_USER_PASSWORD=extrem_pass
```

**Naming convention:**

<ACTOR_NAME>_USER_NAME
<ACTOR_NAME>_USER_PASSWORD

Use uppercase and underscores.

## 2. Synchronization with src/fixtures/user.ts

When a new Actor is introduced, the fixtures file must be updated in two places.

### A. Type Definition (Actors)
```typescript
type Actors = {
    Bob: Actor;
    Edgar_Extrem: Actor; // newly added
};
```

### B. Fixture Implementation

Credentials must be loaded using process.env.

```typescript
export const test = base.extend<Actors>({
    // existing Actors ...

    Edgar_Extrem: async ({ context, request }, use) => {
        const Edgar = await createUser(
            context,
            request,
            'Edgar',
            `${process.env.EDGAR_EXTREM_USER_NAME}`,
            `${process.env.EDGAR_EXTREM_USER_PASSWORD}`
        );

        await use(Edgar);
    },
});
```

### Agent Workflow

When a new persona (e.g. Paul) is required, the agent must:

Add the variables to the .env file
PAUL_USER_NAME=...
PAUL_USER_PASSWORD=...
Update src/fixtures/user.ts
Extend the Actors type with Paul
Register the fixture using process.env.PAUL_USER_NAME and process.env.PAUL_USER_PASSWORD

## Mental Model

.env defines credentials.
Fixtures read credentials.
Actors receive credentials.
Tests use Actors.