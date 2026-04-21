export function generateExampleTest(): string {
  return /* ts */ `import { test } from '../fixtures/user';
import { Element } from '@testla/screenplay-playwright/web';
import { Do } from '../screenplay/tasks';
import { Demo } from '../screenplay/screens';

test('Demo-Test', async ({ Andy }) => {
  await Andy.attemptsTo(Do.something());
  await Andy.asks(Element.toBe.visible(Demo.BODY));
});
`;
}

export function generateUserFixtures(): string {
  return /* ts */ `import { Browser, test as base } from '@playwright/test';
import { Actor } from '@testla/screenplay-playwright';
import { BrowseTheWeb } from '@testla/screenplay-playwright/web';

const createUser = async (
  browser: Browser,
  actorName: string,
  username: string,
  password: string,
): Promise<Actor> => {
  const page = await browser.newPage();

  return Actor.named(actorName)
    .with('username', username)
    .with('password', password)
    .can(BrowseTheWeb.using(page));
};

type Actors = {
  Andy: Actor;
};

export const test = base.extend<Actors>({
  Andy: async ({ browser }, use) => {
    const Andy = await createUser(
      browser,
      'Andy',
      \`\${process.env.ANDY_USER_NAME}\`,
      \`\${process.env.ANDY_USER_PASSWORD}\`,
    );
    await use(Andy);
  },
});

export { expect } from '@playwright/test';
`;
}

export function generateDemoTask(): string {
  return /* ts */ `import { Actor, Task } from '@testla/screenplay-playwright';
import { Navigate, Wait } from '@testla/screenplay-playwright/web';

export class Do extends Task {
  private constructor() {
    super();
  }

  public async performAs(actor: Actor): Promise<unknown> {
    return actor.attemptsTo(
      Navigate.to('/'),
      Wait.forLoadState('networkidle'),
    );
  }

  public static something(): Do {
    const instance = new Do();
    instance.setCallStackInitializeCalledWith({});
    return instance;
  }

  public withWaitState(state: 'WaitState'): Do {
    this.addToCallStack({
      caller: 'withWaitState',
      calledWith: { state },
    });
    return this;
  }
}
`;
}

export function generateTasksIndex(): string {
  return /* ts */ `import { Do } from './demo-task';

export {
  Do,
};
`;
}

export function generateDemoScreen(): string {
  return /* ts */ `export class Demo {
  static BODY = 'body';
}
`;
}

export function generateScreensIndex(): string {
  return /* ts */ `import { Demo } from './demo-screen';

export {
  Demo,
};
`;
}