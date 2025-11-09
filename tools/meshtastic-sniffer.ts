/**
 * Meshtastic Raw Sniffer (TypeScript/Node)
 *
 * Records every line received from a Meshtastic-compatible serial port without
 * applying any parsing. The output is suitable for feeding future parsers or
 * building fixtures/replay logs.
 *
 * Example usage:
 *   pnpm tool:sniffer -- --port /dev/ttyUSB0
 *   pnpm tool:sniffer -- --port COM11 --baud 921600 --output logs/site-a.log
 *   pnpm tool:sniffer -- --port /dev/ttyACM0 --json --no-stdout
 */

import { SerialPort } from 'serialport';
import { DelimiterParser } from '@serialport/parser-delimiter';
import { ArgumentParser } from 'argparse';
import fs from 'node:fs';
import path from 'node:path';

interface SnifferOptions {
  port: string;
  baudRate: number;
  delimiter: Buffer;
  outputPath: string;
  json: boolean;
  stdout: boolean;
  append: boolean;
}

function parseArgs(): SnifferOptions {
  const parser = new ArgumentParser({
    description: 'Meshtastic raw serial sniffer',
  });

  parser.add_argument('-p', '--port', {
    required: true,
    help: 'Serial device path (e.g., /dev/ttyUSB0 or COM5)',
  });

  parser.add_argument('-b', '--baud', {
    default: 115200,
    type: 'int',
    help: 'Baud rate (default: 115200)',
  });

  parser.add_argument('--delimiter', {
    default: '\\n',
    help: 'Delimiter between frames (default: \\n; accepts escaped sequences like \\r\\n)',
  });

  parser.add_argument('-o', '--output', {
    help: 'File to write captured lines to (default: logs/meshtastic-raw-<timestamp>.log)',
  });

  parser.add_argument('--json', {
    action: 'store_true',
    help: 'Emit newline-delimited JSON objects { ts, line } instead of raw text',
  });

  parser.add_argument('--no-stdout', {
    action: 'store_true',
    help: 'Do not echo captured lines to stdout (file only)',
  });

  parser.add_argument('-a', '--append', {
    action: 'store_true',
    help: 'Append to the output file if it already exists',
  });

  const argv = process.argv.slice(2);
  const cleaned = argv.length > 0 && argv[0] === '--' ? argv.slice(1) : argv;
  const args = parser.parse_args(cleaned) as {
    port: string;
    baud: number;
    delimiter: string;
    output?: string | null;
    json: boolean;
    no_stdout: boolean;
    append: boolean;
  };

  const delimiter = decodeDelimiter(args.delimiter);
  const outputPath = resolveOutputPath(args.output ?? undefined);

  return {
    port: args.port,
    baudRate: args.baud,
    delimiter,
    outputPath,
    json: args.json,
    stdout: !args.no_stdout,
    append: args.append,
  };
}

function decodeDelimiter(value: string): Buffer {
  if (!value) {
    return Buffer.from('\n', 'utf8');
  }

  const normalized = value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return Buffer.from(normalized, 'utf8');
}

function resolveOutputPath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), 'logs', `meshtastic-raw-${stamp}.log`);
}

function openOutputStream(filePath: string, append: boolean): fs.WriteStream {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' });
}

function sanitizeLine(input: string): string {
  return input.replace(/\r/g, '');
}

async function main(): Promise<void> {
  const options = parseArgs();
  const output = openOutputStream(options.outputPath, options.append);

  output.on('error', (err) => {
    console.error(
      `[sniffer] failed to write to ${options.outputPath}: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });

  const port = new SerialPort({
    path: options.port,
    baudRate: options.baudRate,
    autoOpen: false,
  });

  port.on('error', (err: Error) => {
    console.error(`[sniffer] serial error: ${err.message}`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    port.open((err: Error | null | undefined) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  console.error(`[sniffer] connected to ${options.port} @ ${options.baudRate}`);
  console.error(`[sniffer] logging raw lines to ${options.outputPath}`);
  console.error('[sniffer] press Ctrl+C to stop');

  const parser = port.pipe(
    new DelimiterParser({
      delimiter: options.delimiter,
      encoding: 'utf8',
    }),
  );

  const writeLine = (payload: string) => {
    output.write(`${payload}\n`);
    if (options.stdout) {
      process.stdout.write(`${payload}\n`);
    }
  };

  parser.on('data', (chunk: string) => {
    const cleaned = sanitizeLine(chunk);
    if (cleaned.length === 0) {
      return;
    }

    if (options.json) {
      const entry = JSON.stringify({ ts: new Date().toISOString(), line: cleaned });
      writeLine(entry);
    } else {
      writeLine(cleaned);
    }
  });

  const shutdown = () => {
    console.error('\n[sniffer] shutting down...');
    parser.removeAllListeners('data');
    port.close(() => {
      output.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[sniffer] failed to start: ${message}`);
  process.exit(1);
});
