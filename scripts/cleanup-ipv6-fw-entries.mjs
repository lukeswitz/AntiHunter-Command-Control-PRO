#!/usr/bin/env node
import { PrismaClient } from '../apps/backend/node_modules/@prisma/client/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

async function removeMailformedIPv6() {
  const malformedPatterns = [
    /^0+:0+:0+:0+:0+:0+:0+:0+$/,
    /^::$/,
    /^[0-9a-f]*::[0-9a-f]*::[0-9a-f]*$/,
    /^[^:]*:[^:]*:[^:]*$/,
  ];

  const allLogs = await prisma.firewallLog.findMany({
    select: { id: true, ip: true }
  });

  const malformed = allLogs.filter(log =>
    malformedPatterns.some(pattern => pattern.test(log.ip))
  );

  if (malformed.length === 0) {
    console.log('No malformed IPv6 addresses found');
    return;
  }

  const ids = malformed.map(log => log.id);
  const result = await prisma.firewallLog.deleteMany({
    where: { id: { in: ids } }
  });

  console.log(`Deleted ${result.count} malformed IPv6 entries`);
  malformed.forEach(log => console.log(`  - ${log.ip}`));
}

removeMailformedIPv6()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
