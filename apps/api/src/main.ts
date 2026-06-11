import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const { port, corsOrigins, trustProxy } = loadConfig();
  if (trustProxy) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }
  app.enableCors({ origin: corsOrigins });
  await app.listen(port);
}

void bootstrap();
