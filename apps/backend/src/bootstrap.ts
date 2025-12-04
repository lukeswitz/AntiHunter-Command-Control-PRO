import { ValidationPipe } from '@nestjs/common';
import { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync, readFileSync } from 'fs';
import helmet from 'helmet';
import { createServer } from 'http';
import { Logger } from 'nestjs-pino';
import { join } from 'path';

import { AppModule } from './app.module';
import { SanitizeInputPipe } from './utils/sanitize-input.pipe';

/**
 * Validates and sanitizes the hostname from the Host header to prevent open redirect attacks.
 * Only allows valid hostname characters and removes any suspicious content.
 */
function validateAndSanitizeHostname(hostHeader: string, logger: Logger): string {
  // Extract hostname without port
  const hostname = hostHeader.split(':')[0] || 'localhost';

  // Validate hostname format - only allow alphanumeric, dots, and hyphens
  // This prevents injection of special characters or malicious URLs
  const hostnameRegex =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

  if (!hostnameRegex.test(hostname)) {
    logger.warn(`Invalid hostname in Host header: ${hostHeader}. Using localhost instead.`);
    return 'localhost';
  }

  // Additional check: hostname should not be too long
  if (hostname.length > 253) {
    logger.warn(`Hostname too long in Host header: ${hostHeader}. Using localhost instead.`);
    return 'localhost';
  }

  return hostname;
}

function resolveHttpsOptions(): HttpsOptions | undefined {
  const enabled =
    process.env.HTTPS_ENABLED === 'true' ||
    (!!process.env.HTTPS_KEY_PATH && !!process.env.HTTPS_CERT_PATH);

  if (!enabled) {
    return undefined;
  }

  const keyPath = process.env.HTTPS_KEY_PATH;
  const certPath = process.env.HTTPS_CERT_PATH;

  if (!keyPath || !certPath) {
    console.warn('[https] HTTPS requested but key/cert paths are missing. Falling back to HTTP.');
    return undefined;
  }

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    console.warn(
      '[https] HTTPS key or cert path not found. Falling back to HTTP.',
      keyPath,
      certPath,
    );
    return undefined;
  }

  try {
    const options: HttpsOptions = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };

    const caPath = process.env.HTTPS_CA_PATH;
    if (caPath) {
      const files = caPath
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const buffers: Buffer[] = [];
      for (const file of files) {
        if (!existsSync(file)) {
          console.warn(`[https] CA path "${file}" does not exist. Skipping.`);
          continue;
        }
        buffers.push(readFileSync(file));
      }
      if (buffers.length === 1) {
        options.ca = buffers[0];
      } else if (buffers.length > 1) {
        options.ca = buffers;
      }
    }

    if (process.env.HTTPS_PASSPHRASE) {
      options.passphrase = process.env.HTTPS_PASSPHRASE;
    }

    console.info('[https] HTTPS enabled using provided certificates.');
    return options;
  } catch (error) {
    console.error('[https] Failed to load HTTPS certificates. Falling back to HTTP.', error);
    return undefined;
  }
}

export async function bootstrap(): Promise<void> {
  const httpsOptions = resolveHttpsOptions();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    httpsOptions,
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'blob:', 'ws:', 'wss:', 'https://tile.openstreetmap.org'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: 'deny' },
      hsts: httpsOptions
        ? {
            maxAge: 31536000,
            includeSubDomains: true,
          }
        : false,
    }),
  );

  const logger = app.get(Logger);
  app.useLogger(logger);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
    new SanitizeInputPipe(),
  );

  const configService = app.get(ConfigService);
  configService.set('https.active', Boolean(httpsOptions));
  const prefix = configService.get<string>('http.prefix', 'api');
  if (prefix) {
    app.setGlobalPrefix(prefix, { exclude: ['healthz', 'readyz', 'metrics'] });
  }

  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/media/',
  });

  const port = configService.get<number>('http.port', 3000);
  await app.listen(port, () => {
    logger.log(`Command Center backend listening on port ${port}`, 'Bootstrap');
  });

  const redirectPort = configService.get<number>('http.redirectPort');
  if (httpsOptions && redirectPort && redirectPort !== port) {
    const httpsPortSuffix = port === 443 ? '' : `:${port}`;
    const redirectServer = createServer((req, res) => {
      // Validate and sanitize the Host header to prevent open redirect attacks
      const hostHeader = req.headers.host ?? '';
      const hostname = validateAndSanitizeHostname(hostHeader, logger);

      // Sanitize the URL path to prevent open redirects via path manipulation
      // Only allow relative paths starting with / and block any attempts to redirect to external URLs
      let path = req.url ?? '/';
      try {
        // Ensure the path doesn't contain protocol-like patterns that could bypass validation
        if (
          path.includes('://') ||
          path.startsWith('//') ||
          path.toLowerCase().startsWith('javascript:') ||
          path.toLowerCase().startsWith('data:') ||
          path.toLowerCase().startsWith('vbscript:')
        ) {
          logger.warn(`Suspicious redirect path detected: ${path}. Using / instead.`);
          path = '/';
        } else {
          // Parse the URL to extract just the pathname and search params (no protocol/host)
          // This also normalizes the path and handles edge cases
          const urlObj = new URL(path, `https://${hostname}`);
          path = urlObj.pathname + urlObj.search;
        }
      } catch (error) {
        logger.warn(`Invalid URL in redirect: ${path}. Using / instead.`);
        path = '/';
      }

      const location = `https://${hostname}${httpsPortSuffix}${path}`;

      res.writeHead(301, { Location: location });
      res.end();
    });

    redirectServer.on('error', (error) => {
      logger.error(
        `Failed to start HTTP redirect listener on port ${redirectPort}: ${error.message}`,
        'Bootstrap',
      );
    });

    redirectServer.listen(redirectPort, () => {
      logger.log(
        `HTTP redirect listener active on port ${redirectPort} -> https port ${port}`,
        'Bootstrap',
      );
    });
  } else if (httpsOptions && redirectPort === port) {
    logger.warn(
      `HTTP redirect port (${redirectPort}) matches HTTPS port (${port}). Redirect listener disabled.`,
      'Bootstrap',
    );
  }
}
