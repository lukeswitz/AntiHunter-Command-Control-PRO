import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .default('3000')
    .transform((val) => Number(val))
    .pipe(z.number().int().min(0).max(65535)),
  HTTP_PREFIX: z.string().default('api'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  STRUCTURED_LOGS: z
    .string()
    .optional()
    .transform((val) => (val ? val !== 'false' : true)),
  SERIAL_DEVICE: z.string().optional(),
  SERIAL_BAUD: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  SERIAL_DELIMITER: z.string().optional(),
  SERIAL_PROTOCOL: z.enum(['meshtastic-like', 'raw-lines', 'nmea-like']).optional(),
  SERIAL_PER_TARGET_RATE: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  SERIAL_GLOBAL_RATE: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  SERIAL_RECONNECT_BASE_MS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  SERIAL_RECONNECT_MAX_MS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  SERIAL_RECONNECT_JITTER: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().min(0).max(1).optional()),
  SERIAL_RECONNECT_MAX_ATTEMPTS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  WS_MAX_CLIENTS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  MAIL_ENABLED: z.string().optional(),
  MAIL_HOST: z.string().optional(),
  MAIL_PORT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  MAIL_USER: z.string().optional(),
  MAIL_PASS: z.string().optional(),
  MAIL_SECURE: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_PREVIEW: z.string().optional(),
  INVITE_EXPIRY_HOURS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  PASSWORD_RESET_EXPIRY_HOURS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  APP_URL: z.string().optional(),
});

export type EnvironmentVariables = z.infer<typeof envSchema>;

export function validateEnvironment(config: Record<string, unknown>): EnvironmentVariables {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const formatted = parsed.error.flatten();
    throw new Error(
      `Invalid environment configuration: ${JSON.stringify(formatted.fieldErrors, null, 2)}`,
    );
  }

  return parsed.data;
}
