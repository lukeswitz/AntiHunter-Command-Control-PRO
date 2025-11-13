#!/usr/bin/env node
import { spawn } from 'child_process';
import { readdirSync } from 'fs';
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
  console.warn('⚠️  Unable to read migrations directory:', error.message);
}

const pnpmPrefix = ['--filter', '@command-center/backend', 'exec', '--', 'prisma'];
const isWindows = process.platform === 'win32';

async function runPrisma(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [...pnpmPrefix, ...args],
      {
        cwd: backendDir,
        shell: isWindows,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      },
    );
    if (!capture) {
      child.on('exit', (code) => {
        if (code === 0) {
          resolve({ code });
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });
      child.on('error', reject);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const error = new Error(stderr || stdout || `Command failed with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function analyzeStatus(output) {
  const text = output.toLowerCase();
  if (text.includes('database schema is up to date')) {
    return 'upToDate';
  }
  if (text.includes('have not yet been applied') || text.includes('pending') || text.includes('need to be applied')) {
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
  const result = await runPrisma(['migrate', 'status', '--schema', prismaSchemaPath], { capture: true });
  return {
    raw: result.stdout + result.stderr,
    state: analyzeStatus(result.stdout + result.stderr),
  };
}

async function applyMigrations() {
  console.log('➡️  Running Prisma migrate deploy…');
  await runPrisma(['migrate', 'deploy', '--schema', prismaSchemaPath]);
  console.log('✅ Migrations applied.\n');
}

async function baselineAllMigrations() {
  if (migrations.length === 0) {
    console.log('⚠️  No migrations directory found. Skipping baseline step.');
    return;
  }
  console.log('📌 Existing schema detected without migration history. Marking migrations as applied…');
  for (const name of migrations) {
    try {
      await runPrisma(['migrate', 'resolve', '--applied', name, '--schema', prismaSchemaPath]);
      console.log(`   • Marked ${name} as applied`);
    } catch (error) {
      if (error.stderr?.includes('already applied') || error.stderr?.includes('already been recorded')) {
        console.log(`   • ${name} already recorded, skipping`);
        continue;
      }
      throw error;
    }
  }
  console.log('✅ Baseline recorded.\n');
}

async function handleDrift(statusOutput) {
  console.error('⚠️  Drift detected: your database schema differs from prisma/schema.prisma.');
  console.error('Review the diff below and reconcile manually.\n');
  console.error(statusOutput);
  console.log('\nSuggested commands:');
  console.log('  pnpm --filter @command-center/backend exec -- prisma migrate diff \\');
  console.log('    --from-schema-datasource --to-schema prisma/schema.prisma --script');
  console.log('  pnpm --filter @command-center/backend exec -- prisma migrate resolve --applied <migration>');
  console.log('\nAfter reconciling, rerun pnpm update-db.');
}

async function main() {
  console.log('=== AntiHunter Command Center :: Database Updater ===\n');
  try {
    const status = await getStatus();
    switch (status.state) {
      case 'upToDate':
        console.log('✅ Database schema is already up to date. No action required.');
        break;
      case 'pending':
        await applyMigrations();
        break;
      case 'needsBaseline':
        await baselineAllMigrations();
        await applyMigrations();
        break;
      case 'drift':
        await handleDrift(status.raw);
        process.exitCode = 1;
        break;
      default:
        console.warn('⚠️  Unable to determine database state automatically. Full output:\n');
        console.log(status.raw);
        console.log('\nPlease review the output above or rerun with `pnpm --filter @command-center/backend exec -- prisma migrate status`.');
        process.exitCode = 1;
    }
  } catch (error) {
    console.error('\n❌ Database update failed.');
    if (error.stderr || error.stdout) {
      console.error(error.stderr || error.stdout);
    } else {
      console.error(error.message);
    }
    console.log('\nIf this happens repeatedly, try:');
    console.log('  pnpm --filter @command-center/backend exec -- prisma migrate deploy');
    console.log('  pnpm --filter @command-center/backend exec -- prisma migrate resolve --help');
    process.exitCode = 1;
  }
}

main();
