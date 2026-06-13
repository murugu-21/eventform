-- Make the delivery machinery domain-agnostic: the producer-supplied event
-- payload becomes a durable column on deliveries, and the submission FK (the
-- one domain-specific column) is dropped. Retry paths re-emit from the stored
-- payload instead of joining back into submissions/forms.

ALTER TABLE deliveries ADD COLUMN payload jsonb;
--> statement-breakpoint

-- Backfill existing rows by reconstructing the payload the same way the API
-- detail endpoint used to (attempt reflects the last attempt actually sent).
UPDATE deliveries d
SET payload = jsonb_build_object(
  'eventId', d.event_id,
  'type', 'submission.received',
  'attempt', GREATEST(d.attempt_count, 1),
  'tenantId', d.tenant_id,
  'formId', f.id,
  'formTitle', f.title,
  'submissionId', s.id,
  'endpointId', d.endpoint_id,
  'deliveryId', d.id,
  'answers', s.answers,
  'submittedAt', to_char(s.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
FROM submissions s, forms f
WHERE s.id = d.submission_id AND f.id = s.form_id;
--> statement-breakpoint

ALTER TABLE deliveries ALTER COLUMN payload SET NOT NULL;
--> statement-breakpoint

ALTER TABLE deliveries DROP CONSTRAINT "deliveries_submission_id_submissions_id_fk";
--> statement-breakpoint

ALTER TABLE deliveries DROP COLUMN submission_id;
