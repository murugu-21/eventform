import { Module } from "@nestjs/common";
import { EndpointsController } from "./endpoints.controller";
import { EndpointsService } from "./endpoints.service";
import { ENDPOINT_REPOSITORY } from "./endpoints.repository";
import { DrizzleEndpointRepository } from "./endpoints.repository.drizzle";

@Module({
  controllers: [EndpointsController],
  providers: [
    EndpointsService,
    { provide: ENDPOINT_REPOSITORY, useClass: DrizzleEndpointRepository },
  ],
})
export class EndpointsModule {}
