// ── Actions & Assertions ──────────────────────────────────────────────────

export type ActionKind = 
  | 'Navigate' | 'Fill' | 'Click' | 'Wait' 
  | 'Select' | 'Hover' | 'Check' | 'Uncheck' | 'Press';

export type AssertionKind = 
  | 'text' | 'visible' | 'hidden' | 'url' 
  | 'count' | 'enabled' | 'disabled' | 'value' | 'checked';

// ── Multi-Step Plan Structure ─────────────────────────────────────────────

export interface ScreenDefinition {
  name: string;
  description: string;
}

export interface TaskAction {
  action: ActionKind;
  hint: string;
  value?: string;
  target?: string; // Resolved during discovery
}

export interface TaskStep {
  type: 'task';
  screenName: string;
  taskName: string;
  actions: TaskAction[];
}

export interface QuestionStep {
  type: 'question';
  screenName: string;
  questionName: string;
  assertion: {
    kind: AssertionKind;
    value?: string;
    hint?: string;
    target?: string; // Resolved during discovery
    description: string;
  };
}

export type FlowStep = TaskStep | QuestionStep;

export interface MultiStepPlan {
  screens: ScreenDefinition[];
  flow: FlowStep[];
}

// ── Discovery & State ─────────────────────────────────────────────────────

export interface ElementInfo {
  propName: string;
  role: string;
  name: string;
  locator: string;
  kind: 'interactive' | 'output';
}

export interface AssertionResult {
  passed: boolean;
  note: string;
  locator: string;
}

export interface DiscoveredState {
  screenName: string;
  url: string;
  elements: ElementInfo[];
  screenshotPath: string;
  assertions: AssertionResult[];
}