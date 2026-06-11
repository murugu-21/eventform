import { Module } from "@nestjs/common";
import { SecretCipher } from "@eventform/shared";
import { loadConfig } from "./config";
import { DbModule, SECRET_CIPHER, WORKER_POOL } from "./db.module";
import { HealthController } from "./health.controller";
import { DeliveryProcessor } from "./processor/delivery-processor.service";
import { WebhookSender } from "./webhook/webhook-sender.service";
import { KafkaConsumerService } from "./kafka/kafka-consumer.service";
import { Pool } from "pg";

@Module({
  imports: [DbModule],
  controllers: [HealthController],
  providers: [
    {
      provide: WebhookSender,
      useFactory: (cipher: SecretCipher) => new WebhookSender(cipher, loadConfig().webhookTimeoutMs),
      inject: [SECRET_CIPHER],
    },
    {
      provide: DeliveryProcessor,
      useFactory: (pool: Pool, sender: WebhookSender) => new DeliveryProcessor(pool, sender),
      inject: [WORKER_POOL, WebhookSender],
    },
    {
      provide: KafkaConsumerService,
      useFactory: (processor: DeliveryProcessor) => new KafkaConsumerService(processor),
      inject: [DeliveryProcessor],
    },
  ],
})
export class AppModule {}
