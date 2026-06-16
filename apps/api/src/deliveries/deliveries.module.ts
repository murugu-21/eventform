import { Module } from "@nestjs/common";
import { DeliveriesController } from "./deliveries.controller";
import { DeliveriesService } from "./deliveries.service";
import { DELIVERY_REPOSITORY } from "./deliveries.repository";
import { DrizzleDeliveryRepository } from "./deliveries.repository.drizzle";

@Module({
  controllers: [DeliveriesController],
  providers: [
    DeliveriesService,
    { provide: DELIVERY_REPOSITORY, useClass: DrizzleDeliveryRepository },
  ],
})
export class DeliveriesModule {}
