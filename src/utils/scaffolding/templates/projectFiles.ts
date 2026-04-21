export function generateReadme(testDir: string, testCommand: string): string {
    return /* md */ `# Testla Screenplay Playwright Project

This project was created with \`create-testla-screenplay\` and uses the Testla Screenplay Pattern together with Playwright for End-to-End testing.

## 📁 Folder Structure

\`\`\`
${testDir}/                   # Test files (E2E Tests)
├── example.spec.ts      # Example test
│
screenplay/              # Screenplay Pattern implementation
├── tasks/               # Tasks - Business logic and workflows
│   └── demo-task.ts     # Example task
├── actions/             # Actions - Simple UI interactions
├── questions/           # Questions - Application state queries
├── screens/             # Screens - Locators and UI element definitions
│   └── demo-screen.ts   # Example screen
│
fixtures/                # Test fixtures and helper functions
├── user.ts              # Actor definitions and test setup
│
playwright.config.ts     # Playwright configuration
.env                     # Environment variables (not in Git)
.gitignore               # Git ignore file
\`\`\`

## 📂 What goes into which folder?

### \`${testDir}/\`
- **Test files**: This is where the actual E2E tests are located
- **Example**: \`login.spec.ts\`, \`checkout.spec.ts\`

### \`screenplay/tasks/\`
- **Business logic**: Composite actions that include multiple steps
- **Example**: "Login", "Purchase product", "Complete order"

### \`screenplay/actions/\`
- **Simple UI interactions**: Basic actions with individual UI elements
- **Example**: "Click button", "Enter text", "Select dropdown"

### \`screenplay/questions/\`
- **State queries**: Checking the current application state
- **Example**: "Is user logged in?", "Is cart empty?"

### \`screenplay/screens/\`
- **UI element definitions**: Locators and selectors for UI elements
- **Example**: Login page elements, header navigation, footer links

### \`fixtures/\`
- **Test setup**: Actor definitions, test data, helper functions
- **Example**: User fixtures, test data, mock data

## 🚀 Running Tests

### Run all tests
\`\`\`bash
${testCommand}
\`\`\`

## 🔧 Configuration

Main configuration is done through:
- **\`playwright.config.ts\`**
- **\`.env\`**

### Important Environment Variables
- \`BASE_URL\`
- \`HEADLESS\`
- \`ANDY_USER_NAME\`
- \`ANDY_USER_PASSWORD\`

## 📚 Documentation

🔗 **Testla Screenplay Playwright Documentation**  
https://github.com/testla-project/testla-screenplay-playwright-js/blob/main/README.md

## 💬 Community & Support

🚀 **Discord**  
https://discord.gg/MDRjCH3v

## 🎭 Happy Testing!
`;
}

export function generateGitignore(): string {
  return `# Playwright
node_modules/
/test-results/
/playwright-report/
/blob-report/
/playwright/.cache/
.DS_Store

# Environment variables
.env
`;
}

export function generateEnvFile(): string {
  return `HEADLESS=true
BASE_URL=
ANDY_USER_NAME=ANDY
ANDY_USER_PASSWORD=the-secret-password
`;
}