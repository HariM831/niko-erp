-- The shed controllers' SETTINGS, kept beside their readings.
--
-- Three tables. The catalogue is what a controller model can be told: every
-- page of its remote-control screen and every register on it, with range,
-- unit and kind, fetched from the vendor once per model rather than typed.
-- A snapshot is what one house's controller was actually set to at an
-- instant, all of it, so that a change made on the panel or on the vendor's
-- site shows up as a diff the next night instead of a mystery a month later.
-- A change is one register that differed between two snapshots, or that niko
-- itself wrote (stage 2), with who and when.
CREATE TABLE controller_catalog (
  model text PRIMARY KEY,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source_house_code text,
  menu jsonb NOT NULL,
  pages jsonb NOT NULL
);

CREATE TABLE controller_snapshots (
  id bigserial PRIMARY KEY,
  house_id uuid NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  taken_at timestamptz NOT NULL DEFAULT now(),
  registers integer NOT NULL,
  values jsonb NOT NULL
);
CREATE INDEX ix_controller_snapshots_house_time ON controller_snapshots (house_id, taken_at);

CREATE TABLE controller_changes (
  id bigserial PRIMARY KEY,
  house_id uuid NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  register text NOT NULL,
  page_code text,
  before text,
  after text,
  seen_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id)
);
CREATE INDEX ix_controller_changes_house_time ON controller_changes (house_id, seen_at);
