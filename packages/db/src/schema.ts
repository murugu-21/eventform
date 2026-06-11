import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const formStatus = pgEnum("form_status", ["draft", "published"]);
export const fieldType = pgEnum("field_type", ["text", "multiple_choice"]);
export const deliveryStatus = pgEnum("delivery_status", [
  "pending",
  "delivered",
  "retrying",
  "failed",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  cognitoSub: text("cognito_sub").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const forms = pgTable("forms", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  title: text("title").notNull(),
  status: formStatus("status").notNull().default("draft"),
  publicSlug: text("public_slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const formFields = pgTable("form_fields", {
  id: uuid("id").primaryKey().defaultRandom(),
  formId: uuid("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  type: fieldType("type").notNull(),
  label: text("label").notNull(),
  options: jsonb("options").$type<string[]>(),
  required: boolean("required").notNull().default(false),
  position: integer("position").notNull(),
}, (t) => [
  index("form_fields_form_idx").on(t.formId),
]);

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  formId: uuid("form_id").notNull().references(() => forms.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  answers: jsonb("answers").$type<Record<string, string>>().notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  sourceIp: text("source_ip"),
}, (t) => [
  index("submissions_form_idx").on(t.formId, t.submittedAt),
]);

export const endpoints = pgTable("endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Transactional outbox. id is the event id. Debezium watches this table. */
export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("outbox_created_idx").on(t.createdAt),
]);

/** Consumer idempotency ledger. Not tenant-scoped; worker-only. */
export const processedEvents = pgTable("processed_events", {
  eventId: uuid("event_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliveries = pgTable("deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  eventId: uuid("event_id").notNull(),
  status: deliveryStatus("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  lastError: text("last_error"),
  responseCode: integer("response_code"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("deliveries_retry_poll_idx").on(t.nextRetryAt).where(sql`status = 'retrying'`),
  index("deliveries_tenant_list_idx").on(t.tenantId, t.status, t.createdAt),
]);

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: uuid("delivery_id")
    .notNull()
    .references(() => deliveries.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  responseCode: integer("response_code"),
  error: text("error"),
  durationMs: integer("duration_ms"),
}, (t) => [
  index("delivery_attempts_delivery_idx").on(t.deliveryId),
]);
