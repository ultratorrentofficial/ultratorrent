import 'reflect-metadata';
import { DynamicModule, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { findInsecureSecrets } from './config/configuration';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

// Express cannot serialise BigInt (torrent snapshot sizes). Emit as string.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export interface UltraTorrentAppOptions {
  /**
   * Extra NestJS modules to import. The app never imports these itself — a host
   * may supply them to extend the app with additional modules.
   */
  externalModules?: Array<unknown>;
}

/** Root module that composes the app (`AppModule`) with any external modules. */
class UltraTorrentRootModule {
  static forRoot(extra: Array<unknown>): DynamicModule {
    return {
      module: UltraTorrentRootModule,
      imports: [AppModule, ...(extra as DynamicModule[])],
    };
  }
}

/**
 * Build (but do not start) the UltraTorrent Nest application. Normally called
 * with no options; a host may pass `externalModules` to add extra modules.
 */
export async function createUltraTorrentApp(
  options: UltraTorrentAppOptions = {},
): Promise<INestApplication> {
  const root = UltraTorrentRootModule.forRoot(options.externalModules ?? []);
  const app = await NestFactory.create(root, { bufferLogs: false });
  const config = app.get(ConfigService);
  const bootLogger = new Logger('Bootstrap');

  // Refuse to boot in production with unset/default/weak secrets — a known
  // secret lets an attacker forge SUPER_ADMIN tokens (full auth bypass).
  const secretProblems = findInsecureSecrets({
    accessSecret: config.get<string>('jwt.accessSecret') ?? '',
    encryptionKey: config.get<string>('encryptionKey') ?? '',
  });
  if (secretProblems.length) {
    const detail = secretProblems.map((p) => `  - ${p}`).join('\n');
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `Refusing to start: insecure secret configuration:\n${detail}\n` +
          'Set strong, distinct JWT_ACCESS_SECRET and ENCRYPTION_KEY (>=32 random chars).',
      );
    }
    bootLogger.warn(`Insecure secrets (OK for dev, NOT production):\n${detail}`);
  }

  // Behind nginx/Caddy: trust the first proxy hop so req.ip (rate limiting,
  // audit) reflects the real client, not the proxy.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.get<string>('corsOrigin')?.split(',') ?? true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger exposes the full API surface (routes, DTO shapes, auth scheme).
  // Keep it out of production to avoid handing attackers a map.
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('UltraTorrent API')
      .setDescription('Modern torrent management platform — REST API')
      .setVersion('0.10.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  return app;
}

/** Start the app. */
export async function startUltraTorrentApp(
  options: UltraTorrentAppOptions = {},
): Promise<INestApplication> {
  const app = await createUltraTorrentApp(options);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const port = config.get<number>('port') ?? 4000;
  await app.listen(port);
  logger.log(`UltraTorrent API listening on http://0.0.0.0:${port}`);
  if (process.env.NODE_ENV !== 'production') {
    logger.log(`OpenAPI docs at http://0.0.0.0:${port}/api/docs`);
  }
  return app;
}
