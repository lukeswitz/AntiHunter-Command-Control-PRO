export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  site: {
    id: process.env.SITE_ID ?? 'default',
  },
  http: {
    port: Number(process.env.PORT ?? 3000),
    prefix: process.env.HTTP_PREFIX ?? 'api',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  serial: {
    device: process.env.SERIAL_DEVICE,
    baudRate: process.env.SERIAL_BAUD ? Number(process.env.SERIAL_BAUD) : 115200,
    delimiter: process.env.SERIAL_DELIMITER ?? '\n',
    protocol: process.env.SERIAL_PROTOCOL ?? 'meshtastic-like',
    perTargetRate: process.env.SERIAL_PER_TARGET_RATE
      ? Number(process.env.SERIAL_PER_TARGET_RATE)
      : 8,
    globalRate: process.env.SERIAL_GLOBAL_RATE ? Number(process.env.SERIAL_GLOBAL_RATE) : 30,
    reconnectBaseMs: process.env.SERIAL_RECONNECT_BASE_MS
      ? Number(process.env.SERIAL_RECONNECT_BASE_MS)
      : 500,
    reconnectMaxMs: process.env.SERIAL_RECONNECT_MAX_MS
      ? Number(process.env.SERIAL_RECONNECT_MAX_MS)
      : 5000,
    reconnectJitter: process.env.SERIAL_RECONNECT_JITTER
      ? Number(process.env.SERIAL_RECONNECT_JITTER)
      : 0.3,
    reconnectMaxAttempts: process.env.SERIAL_RECONNECT_MAX_ATTEMPTS
      ? Number(process.env.SERIAL_RECONNECT_MAX_ATTEMPTS)
      : 0,
  },
  websocket: {
    maxClients: process.env.WS_MAX_CLIENTS ? Number(process.env.WS_MAX_CLIENTS) : 200,
  },
  logging: {
    level: process.env.LOG_LEVEL ?? 'info',
    structured: process.env.STRUCTURED_LOGS !== 'false',
  },
  mail: {
    enabled: process.env.MAIL_ENABLED !== 'false' && !!process.env.MAIL_HOST,
    host: process.env.MAIL_HOST,
    port: process.env.MAIL_PORT
      ? Number(process.env.MAIL_PORT)
      : process.env.MAIL_HOST
        ? process.env.MAIL_SECURE === 'true'
          ? 465
          : 587
        : undefined,
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    secure: process.env.MAIL_SECURE === 'true',
    from: process.env.MAIL_FROM ?? 'Command Center <no-reply@command-center.local>',
    preview: process.env.MAIL_PREVIEW === 'true',
  },
  security: {
    invitationExpiryHours: process.env.INVITE_EXPIRY_HOURS
      ? Number(process.env.INVITE_EXPIRY_HOURS)
      : 48,
    passwordResetExpiryHours: process.env.PASSWORD_RESET_EXPIRY_HOURS
      ? Number(process.env.PASSWORD_RESET_EXPIRY_HOURS)
      : 4,
    appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  },
  tak: {
    enabled: process.env.TAK_ENABLED === 'true',
    protocol: process.env.TAK_PROTOCOL ?? 'UDP',
    host: process.env.TAK_HOST,
    port: process.env.TAK_PORT ? Number(process.env.TAK_PORT) : undefined,
    tlsEnabled: process.env.TAK_TLS === 'true',
    username: process.env.TAK_USERNAME,
    password: process.env.TAK_PASSWORD,
    apiKey: process.env.TAK_API_KEY,
  },
});
