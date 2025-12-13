import { bootstrap } from './bootstrap';

// Check for silent flag (from command line or environment variable)
const isSilent =
  process.argv.includes('--silent') ||
  process.argv.includes('-s') ||
  process.env.SILENT === 'true';

if (isSilent) {
  // Set log level to error to suppress all output except critical errors
  process.env.LOG_LEVEL = 'error';

  // Suppress console output except for errors
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.debug = () => {};
}

bootstrap().catch((error) => {
  console.error('Fatal error starting Command Center backend', error);
  process.exit(1);
});
