-- Private operator evidence. Never part of owner context or public projections.
CREATE TABLE provider_guardrail_artifacts (
  id uuid PRIMARY KEY,
  manifest_id uuid NOT NULL REFERENCES provider_manifests(id),
  kind text NOT NULL CHECK(kind IN ('assignment','key_limit','negative_response','adjudication')),
  synthetic boolean NOT NULL,
  body jsonb NOT NULL,
  body_hash text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX provider_guardrail_artifacts_manifest ON provider_guardrail_artifacts(manifest_id,kind);
