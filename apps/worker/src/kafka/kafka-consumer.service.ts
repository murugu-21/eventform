import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { Consumer, Kafka, logLevel } from "kafkajs";
import type { Admin } from "kafkajs";
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
    // Ensure the topic exists before subscribing. On a fresh deploy no event has
    // been produced yet, so the topic is absent and the consumer's metadata fetch
    // would throw "This server does not host this topic-partition" and crash the
    // process. createTopics is idempotent (returns false if it already exists).
    const admin: Admin = kafka.admin();
    try {
      await admin.connect();
      await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: EVENTS_TOPIC, numPartitions: 1, replicationFactor: 1 }],
      });
    } finally {
      await admin.disconnect();
    }

    this.consumer = kafka.consumer({ groupId: CONSUMER_GROUP });

    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      if (!payload.restart) {
        this.logger.error(`consumer crashed fatally (${payload.error?.message}); exiting for supervisor restart`);
        process.exit(1);
      }
    });

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
