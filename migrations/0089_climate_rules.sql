-- Stage 2 of the shed controls: rules and proposals.
--
-- A rule is a farm policy with parameters — "pads start at 31.5 when the
-- week's humidity is over 80%" — held once at farm level and overridable per
-- house. A proposal is what a rule wants changed on one house right now: the
-- registers, was and will be, the evidence, and what happened when a person
-- approved it. Nothing is written to a controller except through a proposal.
CREATE TABLE controller_rules (
  id bigserial PRIMARY KEY,
  house_id uuid REFERENCES houses(id) ON DELETE CASCADE,
  key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_controller_rules_house ON controller_rules (key, house_id) WHERE house_id IS NOT NULL;
CREATE UNIQUE INDEX uq_controller_rules_farm ON controller_rules (key) WHERE house_id IS NULL;

CREATE TABLE controller_proposals (
  id bigserial PRIMARY KEY,
  house_id uuid NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  rule text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  written_at timestamptz,
  write_record jsonb,
  snapshot_before bigint REFERENCES controller_snapshots(id)
);
CREATE INDEX ix_controller_proposals_house ON controller_proposals (house_id, status, created_at);
