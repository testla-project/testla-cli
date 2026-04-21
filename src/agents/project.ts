import { logger } from "../utils/logger.ts";
import { detectPackageManager, installDeps, run } from '../utils/scaffolding/package-manager.ts';
import { updatePackageJson } from '../utils/scaffolding/packageSetup.ts';
import { generateAllFiles } from "../utils/scaffolding/fileGenerator.ts";

const TESTLA_MARKERS = [
  "@testla/screenplay-playwright",
];

const BASE_DEPENDENCIES = [
  "@playwright/test",
  "@testla/screenplay-playwright",
  "dotenv"
]; 

const DEV_DEPENDENCIES = [
  "@types/node"
]; 

export interface ProjectSetupResult {
  existed: boolean;
  projectDir: string;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Prüft ob ein testla-screenplay-playwright Projekt vorhanden ist.
 * Falls nicht: legt eines via create-testla an.
 * [MVP: Returns mock data]
 */
export async function ensureTestlaProject(
  workingDir: string,
): Promise<ProjectSetupResult> {
  logger.agentStart("ProjectSetup", "setup", "Prüfe testla-screenplay-playwright Projekt");

  const projectDir = await detectProjectRoot(workingDir);
  const existing = await detectExistingProject(projectDir);

  logger.info("Project Setup", `Arbeitsverzeichnis: ${projectDir}`);

  try {
    await scaffoldProject(projectDir);
  } catch (error) {
    logger.agentEnd("Project Setup", "setup", "failed", String(error));
    throw error;
  }

  logger.agentEnd(
    "Project Setup",
    "setup",
    "success",
    existing ? "Projekt ergänzt und validiert" : `Projekt erstellt: ${projectDir}`,
  );
  return { existed: Boolean(existing), projectDir };
}

async function detectProjectRoot(cwd: string): Promise<string> {
  try {
    const stat = await Deno.stat(`${cwd}/package.json`);
    if (stat.isFile) return cwd;
  } catch {
    // continue
  }

  const nested = await detectExistingProject(cwd);
  return nested ?? cwd;
}

async function detectExistingProject(cwd: string): Promise<string | null> {
  // 1. package.json im CWD prüfen
  const pkgPath = `${cwd}/package.json`;
  try {
    const raw = await Deno.readTextFile(pkgPath);
    const pkg = JSON.parse(raw);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const hasTestla = TESTLA_MARKERS.some((m) => m in allDeps);
    if (hasTestla) return cwd;
  } catch {
    // keine package.json oder kein JSON — weiter suchen
  }

  // 2. Unterverzeichnisse eine Ebene tief durchsuchen
  try {
    for await (const entry of Deno.readDir(cwd)) {
      if (!entry.isDirectory) continue;
      const subPkg = `${cwd}/${entry.name}/package.json`;
      try {
        const raw = await Deno.readTextFile(subPkg);
        const pkg = JSON.parse(raw);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const hasTestla = TESTLA_MARKERS.some((m) => m in allDeps);
        if (hasTestla) return `${cwd}/${entry.name}`;
      } catch {
        continue;
      }
    }
  } catch {
    // readDir fehlgeschlagen
  }

  return null;
}

async function scaffoldProject(cwd: string): Promise<void> {
  const pm = detectPackageManager();
  logger.info("Project Setup", `Detected Package-Manager: ${pm}`);

  const testCommand = pm === 'npm' ? 'npm test' : pm === 'yarn' ? 'yarn test' : 'pnpm test';

  const initCommand = {
    npm: "npm init -y",
    yarn: "yarn init -y",
    pnpm: "pnpm init"
  }[pm];

  const packageJsonPath = `${cwd}/package.json`;
  let pkgExists = true;
  try {
    await Deno.stat(packageJsonPath);
  } catch {
    pkgExists = false;
  }

  if (!pkgExists) {
    logger.info("Project Setup", `🚀 Initializing Testla Screenplay project → ${cwd}`);
    await run(initCommand, { cwd });
  }

  const pkg = await readPackageJson(cwd);
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  const missingBaseDeps = BASE_DEPENDENCIES.filter((dep) => !(dep in deps));
  if (missingBaseDeps.length > 0) {
    logger.info("Project Setup", `→ Installing dependencies: ${missingBaseDeps.join(', ')}`);
    await installDeps(missingBaseDeps, false, cwd);
  }

  const missingDevDeps = DEV_DEPENDENCIES.filter((dep) => !(dep in deps));
  if (missingDevDeps.length > 0) {
    logger.info("Project Setup", `→ Installing dev dependencies: ${missingDevDeps.join(', ')}`);
    await installDeps(missingDevDeps, true, cwd);
  }

  logger.info("Project Setup", '→ Updating package.json scripts...');
  await updatePackageJson(cwd);

  const directories = [
    'tests',
    'fixtures',
    'screenplay/tasks',
    'screenplay/actions',
    'screenplay/questions',
    'screenplay/screens',
  ];

  for (const dir of directories) {
    await Deno.mkdir(`${cwd}/${dir}`, { recursive: true });
  }

  await generateAllFiles('tests', testCommand, cwd);

  logger.info("Project Setup", '→ Ensuring Playwright browsers are installed...');
  await run("npx playwright install chromium", { cwd });
}

async function readPackageJson(cwd: string): Promise<PackageJsonShape> {
  const raw = await Deno.readTextFile(`${cwd}/package.json`);
  return JSON.parse(raw) as PackageJsonShape;
}
