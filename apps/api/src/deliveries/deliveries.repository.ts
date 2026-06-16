import type { Executor } from "@eventform/db";
import { deliveries, deliveryAttempts } from "@eventform/db";
import type { ListDeliveriesQuery } from "./deliveries.schemas";

export const DELIVERY_REPOSITORY = "DELIVERY_REPOSITORY";

export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;

export interface DeliveryListItem {
  id: string;
  endpointId: string;
  endpointName: string;
  payload: DeliveryRow["payload"];
  status: DeliveryRow["status"];
  attemptCount: DeliveryRow["attemptCount"];
  nextRetryAt: DeliveryRow["nextRetryAt"];
  lastError: DeliveryRow["lastError"];
  responseCode: DeliveryRow["responseCode"];
  deliveredAt: DeliveryRow["deliveredAt"];
  createdAt: DeliveryRow["createdAt"];
}

export interface DeliveryRepository {
  list(x: Executor, tenantId: string, query: ListDeliveriesQuery): Promise<DeliveryListItem[]>;
  findById(x: Executor, id: string): Promise<DeliveryRow | undefined>;
  listAttempts(x: Executor, deliveryId: string): Promise<DeliveryAttemptRow[]>;
  /** SELECT ... FOR UPDATE — used to lock the row before a manual retry. */
  findByIdForUpdate(x: Executor, id: string): Promise<DeliveryRow | undefined>;
  /**
   * Manual retry, one atomic unit: insert a fresh outbox row from the stored
   * payload and reset the delivery to pending. Both writes run on `x`.
   */
  reEmitRetry(
    x: Executor,
    args: { delivery: DeliveryRow; tenantId: string; eventId: string; payload: DeliveryRow["payload"] },
  ): Promise<DeliveryRow>;
}
