import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const { port } = loadConfig();
  await app.listen(port);
}

void bootstrap();
