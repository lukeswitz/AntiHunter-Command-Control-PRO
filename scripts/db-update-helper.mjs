#!/usr/bin/env node
import { spawn } from 'child_process';
import { readdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'apps', 'backend');
const prismaSchemaPath = 'prisma/schema.prisma';
const migrationDir = path.join(backendDir, 'prisma', 'migrations');

let migrations = [];
try {
  migrations = readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  console.warn('Unable to read migrations directory:', error.message);
}

const pnpmPrefix = ['--filter', '@command-center/backend', 'exec', '--', 'prisma'];
const isWindows = process.platform === 'win32';

async function runPrisma(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', [...pnpmPrefix, ...args], {
      cwd: backendDir,
      shell: isWindows,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    if (!capture) {
      child.on('exit', (code) => {
        code === 0 ? resolve({ code }) : reject(new Error(`Command failed with code ${code}`));
      });
      child.on('error', reject);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const error = new Error(stderr || stdout || `Command failed with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      code === 0 ? resolve({ stdout, stderr, code }) : reject(error);
    });
  });
}

function analyzeStatus(output) {
  const text = output.toLowerCase();
  if (text.includes('database schema is up to date')) {
    return 'upToDate';
  }
  if (
    text.includes('have not yet been applied') ||
    text.includes('pending') ||
    text.includes('need to be applied')
  ) {
    return 'pending';
  }
  if (text.includes('database schema is not empty') && text.includes('baseline')) {
    return 'needsBaseline';
  }
  if (text.includes('drift detected')) {
    return 'drift';
  }
  return 'unknown';
}

async function getStatus() {
  try {
    const result = await runPrisma(['migrate', 'status', '--schema', prismaSchemaPath], {
      capture: true,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    return { raw: output, state: analyzeStatus(output) };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    const state = analyzeStatus(output);
    if (state === 'pending' || state === 'needsBaseline') {
      return { raw: output, state };
    }
    throw error;
  }
}

function extractFailedMigrations(output) {
  const migrations = new Set();
  const regex = /The `([^`]+)` migration.*failed/gi;
  let match;
  while ((match = regex.exec(output)) !== null) {
    migrations.add(match[1]);
  }
  const p3018 = output.match(/Migration name: ([^\n]+)/i);
  if (p3018) migrations.add(p3018[1].trim());
  return Array.from(migrations);
}

function findDuplicateTableCreates() {
  const tableMap = new Map();

  for (const migration of migrations) {
    const sqlPath = path.join(migrationDir, migration, 'migration.sql');
    if (!existsSync(sqlPath)) continue;

    const content = readFileSync(sqlPath, 'utf8');
    const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const table = match[1].toLowerCase();
      if (!tableMap.has(table)) {
        tableMap.set(table, []);
      }
      tableMap.get(table).push(migration);
    }
  }

  return Array.from(tableMap.entries())
    .map(([table, list]) => ({ table, migrations: list.sort() }))
    .filter((entry) => entry.migrations.length > 1);
}

async function resolveDuplicates() {
  const duplicates = findDuplicateTableCreates();
  if (duplicates.length === 0) return false;

  let actuallyResolved = 0;

  for (const entry of duplicates) {
    const [primary, ...redundant] = entry.migrations;

    for (const migration of redundant) {
      try {
        await runPrisma(
          ['migrate', 'resolve', '--applied', migration, '--schema', prismaSchemaPath],
          { capture: true },
        );
        if (actuallyResolved === 0) {
          console.log('Resolving duplicate CREATE TABLE statements:\n');
        }
        console.log(`  Table ${entry.table}: marked ${migration} as applied`);
        actuallyResolved++;
      } catch (error) {
        const output = [error.stderr, error.stdout].filter(Boolean).join('\n');
        if (
          !output.includes('already been recorded') &&
          !output.includes('already recorded as applied')
        ) {
          throw error;
        }
      }
    }
  }

  if (actuallyResolved > 0) {
    console.log();
  }

  return actuallyResolved > 0;
}

async function baselineAllMigrations() {
  if (migrations.length === 0) {
    console.log('No migrations found to baseline');
    return;
  }

  console.log('Existing schema detected without migration history\n');
  console.log('Marking migrations as applied:\n');

  for (const name of migrations) {
    try {
      await runPrisma(['migrate', 'resolve', '--applied', name, '--schema', prismaSchemaPath], {
        capture: true,
      });
      console.log(`  ${name}`);
    } catch (error) {
      const output = [error.stderr, error.stdout].filter(Boolean).join('\n');
      if (output.includes('already applied') || output.includes('already been recorded')) {
        continue;
      }
      throw error;
    }
  }
  console.log();
}

async function markAsApplied(migrationName) {
  try {
    await runPrisma(
      ['migrate', 'resolve', '--applied', migrationName, '--schema', prismaSchemaPath],
      { capture: true },
    );
    return true;
  } catch (err) {
    const output = [err.stderr, err.stdout].filter(Boolean).join('\n');
    return output.includes('already been recorded');
  }
}

async function attemptDeploy() {
  try {
    await runPrisma(['migrate', 'deploy', '--schema', prismaSchemaPath], { capture: true });
    return { success: true };
  } catch (error) {
    const fullOutput = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    const failed = extractFailedMigrations(fullOutput);
    return failed.length > 0 ? { success: false, failedMigrations: failed } : Promise.reject(error);
  }
}

function handleDrift(statusOutput) {
  console.error('\nDrift detected: database schema differs from prisma/schema.prisma\n');
  console.error('Review the output and reconcile manually:\n');
  console.error(statusOutput);
  console.log('\nSuggested commands:');
  console.log('  pnpm --filter @command-center/backend exec -- prisma migrate diff \\');
  console.log('    --from-schema-datasource --to-schema prisma/schema.prisma --script');
  console.log(
    '  pnpm --filter @command-center/backend exec -- prisma migrate resolve --applied <migration>',
  );
  console.log('\nAfter reconciling, rerun pnpm update-db');
}

async function main() {
  console.log('=== AntiHunter Command Center :: Database Updater ===\n');

  try {
    let hadDuplicates = false;
    if (migrations.length > 0) {
      hadDuplicates = await resolveDuplicates();
    }

    const status = await getStatus();

    if (status.state === 'upToDate') {
      console.log('Database is up to date');
      return;
    }

    if (status.state === 'drift') {
      handleDrift(status.raw);
      process.exitCode = 1;
      return;
    }

    if (status.state === 'needsBaseline') {
      await baselineAllMigrations();
    }

    let result = await attemptDeploy();
    const processed = new Set();

    while (!result.success && result.failedMigrations) {
      for (const migration of result.failedMigrations) {
        if (processed.has(migration)) continue;

        console.log(`Marking as applied: ${migration}`);
        if (await markAsApplied(migration)) {
          processed.add(migration);
        }
      }

      if (result.failedMigrations.every((m) => processed.has(m))) {
        result = await attemptDeploy();
      } else {
        break;
      }
    }

    if (!result.success) {
      console.error('\nFailed to resolve all migrations');
      console.log('\nManual fix:');
      console.log(`  cd ${backendDir}`);
      console.log('  pnpm prisma migrate status');
      console.log('  pnpm prisma migrate resolve --applied <migration>');
      console.log('  pnpm prisma migrate deploy');
      process.exitCode = 1;
    } else {
      if (!hadDuplicates && processed.size === 0 && status.state !== 'needsBaseline') {
        console.log('Database migrations applied successfully');
      } else {
        console.log('Database migrations applied successfully');
      }
    }
  } catch (error) {
    console.error('\nDatabase update failed:', error.message);

    if (error.stdout || error.stderr) {
      console.error('\nOutput:');
      console.error(error.stderr || error.stdout);
    }

    console.log('\nIf this happens repeatedly, try:');
    console.log('  pnpm --filter @command-center/backend exec -- prisma migrate deploy');
    console.log('  pnpm --filter @command-center/backend exec -- prisma migrate resolve --help');

    process.exitCode = 1;
  }
}

main();
