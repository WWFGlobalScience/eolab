-- Processing owns this schema; pgSTAC migrations and tables are untouched.
CREATE SCHEMA IF NOT EXISTS processing;
CREATE TABLE IF NOT EXISTS processing.schema_version (
    version integer PRIMARY KEY
);
-- Early clip-only installations constrained this registry to version 1.
ALTER TABLE processing.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check;
INSERT INTO processing.schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS processing.plans (
    id text PRIMARY KEY,
    owner text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    planning_until timestamptz,
    request jsonb NOT NULL,
    spec jsonb
);
CREATE INDEX IF NOT EXISTS plans_owner ON processing.plans(owner, expires_at);
ALTER TABLE processing.plans ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready';
ALTER TABLE processing.plans ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE processing.plans ADD COLUMN IF NOT EXISTS error jsonb;
ALTER TABLE processing.plans ADD COLUMN IF NOT EXISTS queued_at timestamptz;
ALTER TABLE processing.plans ADD COLUMN IF NOT EXISTS request_deadline timestamptz;
CREATE INDEX IF NOT EXISTS plans_waiting ON processing.plans(state, queued_at);
CREATE TABLE IF NOT EXISTS processing.jobs (
    id text PRIMARY KEY,
    owner text NOT NULL,
    request_key text NOT NULL,
    plan_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'ready', 'failed', 'cancelled', 'interrupted', 'expired', 'deleted')),
    spec jsonb,
    reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempt_id text,
    lease_until timestamptz,
    deadline_at timestamptz,
    progress jsonb NOT NULL DEFAULT '{}'::jsonb,
    artifact jsonb,
    error jsonb,
    UNIQUE (owner, request_key)
);
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT '';
INSERT INTO processing.schema_version VALUES (2) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS jobs_owner ON processing.jobs(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status ON processing.jobs(status, created_at);
CREATE TABLE IF NOT EXISTS processing.transfers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_job ON processing.transfers(job_id, expires_at);

-- A hint is delivered only after the state transaction commits. The payload is
-- an internal owner hash, never a session cookie, job result, input or path.
CREATE OR REPLACE FUNCTION processing.notify_job_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.status IS NOT DISTINCT FROM OLD.status
           AND NEW.progress IS NOT DISTINCT FROM OLD.progress THEN
            RETURN NEW;
        END IF;
    END IF;
    PERFORM pg_notify('eolab_processing_job_changes', NEW.owner);
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS processing_job_change ON processing.jobs;
CREATE TRIGGER processing_job_change AFTER INSERT OR UPDATE OF status, progress ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.notify_job_change();
INSERT INTO processing.schema_version VALUES (3) ON CONFLICT DO NOTHING;

-- Small completed values only: no source paths, polygons or artifact references.
CREATE TABLE IF NOT EXISTS processing.calculation_results (
    cache_key text PRIMARY KEY CHECK (cache_key ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 32768),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS calculation_results_expiry
    ON processing.calculation_results(expires_at);
INSERT INTO processing.schema_version VALUES (4) ON CONFLICT DO NOTHING;

-- Bounded owner-private calculation inputs. Accepted jobs retain their own copy.
CREATE TABLE IF NOT EXISTS processing.inputs (
    id text PRIMARY KEY,
    owner text NOT NULL,
    sha256 text NOT NULL,
    payload jsonb NOT NULL,
    bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 8388608),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS inputs_expiry ON processing.inputs(expires_at);
INSERT INTO processing.schema_version VALUES (5) ON CONFLICT DO NOTHING;

-- The existing owner-scoped SSE connection also hints at plan state changes.
-- Results stay in the database and are fetched through authorized HTTP reads.
CREATE OR REPLACE FUNCTION processing.notify_plan_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state THEN
        PERFORM pg_notify('eolab_processing_job_changes', NEW.owner);
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS processing_plan_change ON processing.plans;
CREATE TRIGGER processing_plan_change AFTER UPDATE OF state ON processing.plans
FOR EACH ROW EXECUTE FUNCTION processing.notify_plan_change();
INSERT INTO processing.schema_version VALUES (6) ON CONFLICT DO NOTHING;

-- Job input storage and session turns are separate from native execution limits.
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS input_bytes bigint;
UPDATE processing.jobs SET input_bytes = CASE WHEN spec IS NULL THEN 0 ELSE
    octet_length(spec::text)::bigint + octet_length(summary::text) END
    WHERE input_bytes IS NULL;
ALTER TABLE processing.jobs ALTER COLUMN input_bytes SET DEFAULT 0;
ALTER TABLE processing.jobs ALTER COLUMN input_bytes SET NOT NULL;
-- Keep accounting correct while an older app/worker overlaps this migration.
-- Old writers do not know input_bytes, but still insert/clear these JSON columns.
CREATE OR REPLACE FUNCTION processing.measure_job_input_bytes() RETURNS trigger AS $$
BEGIN
    NEW.input_bytes := CASE WHEN NEW.spec IS NULL THEN 0 ELSE
        octet_length(NEW.spec::text)::bigint + octet_length(NEW.summary::text) END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS processing_job_input_bytes ON processing.jobs;
CREATE TRIGGER processing_job_input_bytes BEFORE INSERT OR UPDATE OF spec,summary
    ON processing.jobs FOR EACH ROW EXECUTE FUNCTION processing.measure_job_input_bytes();
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
-- Earlier jobs have no recorded start time. Their last update supplies a
-- one-time approximation for scheduling history, never calculation timing.
UPDATE processing.jobs SET started_at=updated_at
    WHERE started_at IS NULL AND attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_owner_started ON processing.jobs(owner, started_at DESC)
    WHERE started_at IS NOT NULL;
INSERT INTO processing.schema_version VALUES (7) ON CONFLICT DO NOTHING;

-- Direct calculation jobs carry input identity without an external plan record.
ALTER TABLE processing.jobs ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS preparation jsonb;
INSERT INTO processing.schema_version VALUES (8) ON CONFLICT DO NOTHING;

-- Worker startup discards unfinished jobs; no persisted compatibility versions.
ALTER TABLE processing.jobs DROP COLUMN IF EXISTS job_format_version;
DROP TRIGGER IF EXISTS processing_claim_protocol ON processing.jobs;
DROP FUNCTION IF EXISTS processing.require_claim_protocol();
ALTER TABLE processing.jobs DROP COLUMN IF EXISTS minimum_claim_version;
INSERT INTO processing.schema_version VALUES (9) ON CONFLICT DO NOTHING;
