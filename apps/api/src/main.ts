import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";
import { stampActivity } from "./activity";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const { port, corsOrigins } = loadConfig();
  // No Express `trust proxy`: the client IP comes from CF-Connecting-IP (see
  // client-ip.ts), not from X-Forwarded-For parsing.
  app.enableCors({ origin: corsOrigins });
  await app.listen(port);
  // Stamp activity on boot so the idle-stop timer measures from startup even if
  // no requests arrive — a woken-but-unused box still idles back down.
  stampActivity();
}

void bootstrap();
