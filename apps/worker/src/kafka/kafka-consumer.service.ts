import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { Consumer, Kafka, logLevel } from "kafkajs";
import { submissionReceivedSchema } from "@eventform/shared";
import { loadConfig } from "../config";
import { DeliveryProcessor } from "../processor/delivery-processor.service";

export const EVENTS_TOPIC = "eventform.events";
export const CONSUMER_GROUP = "eventform-worker";

@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer: Consumer | null = null;

  constructor(private readonly processor: DeliveryProcessor) {}

  async onApplicationBootstrap(): Promise<void> {
    const kafka = new Kafka({
      clientId: "eventform-worker",
      brokers: loadConfig().kafkaBrokers,
      logLevel: logLevel.WARN,
    });
    this.consumer = kafka.consumer({ groupId: CONSUMER_GROUP });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: EVENTS_TOPIC, fromBeginning: false });

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString("utf8");
        let parsed: ReturnType<typeof submissionReceivedSchema.parse> | null = null;
        if (raw) {
          try {
            parsed = submissionReceivedSchema.parse(JSON.parse(raw));
          } catch (err) {
            // Poison pill: log + ack. A malformed event must not crash-loop.
            this.logger.error(
              `skipping unparseable message at ${topic}/${partition}@${message.offset}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        if (parsed) {
          // Throws on processing errors (e.g. DB down) → offset NOT committed →
          // kafkajs redelivers. That is the at-least-once contract.
          const outcome = await this.processor.process(parsed);
          this.logger.log(`event ${parsed.eventId} → ${outcome}`);
        }
        await this.consumer!.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ]);
      },
    });
    this.logger.log(`consuming ${EVENTS_TOPIC} as ${CONSUMER_GROUP}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
