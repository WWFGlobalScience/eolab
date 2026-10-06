-- Processing owns this schema; pgSTAC migrations and tables are untouched.
CREATE SCHEMA IF NOT EXISTS processing;
CREATE TABLE IF NOT EXISTS processing.schema_version (
    version integer PRIMARY KEY
);
-- Early clip-only installations constrained this registry to version 1.
ALTER TABLE processing.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check;
INSERT INTO processing.schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS processing.jobs (
    id text PRIMARY KEY,
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
    error jsonb
);
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT '';
INSERT INTO processing.schema_version VALUES (2) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS jobs_status ON processing.jobs(status, created_at);
CREATE TABLE IF NOT EXISTS processing.transfers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_job ON processing.transfers(job_id, expires_at);

-- A hint is delivered only after the state transaction commits. The payload is
-- an internal owner hash, never a session cookie, job result, input or path.
DROP TRIGGER IF EXISTS processing_job_change ON processing.jobs;
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

INSERT INTO processing.schema_version VALUES (6) ON CONFLICT DO NOTHING;

-- Metadata retention uses record counts and individual payload limits, not a
-- cumulative JSON byte budget. Recreate the dependent view below in this transaction.
DROP VIEW IF EXISTS processing.subscribed_jobs;
DROP TRIGGER IF EXISTS processing_job_input_bytes ON processing.jobs;
DROP FUNCTION IF EXISTS processing.measure_job_input_bytes();
ALTER TABLE processing.jobs DROP COLUMN IF EXISTS input_bytes;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
-- Earlier jobs have no recorded start time. Their last update supplies a
-- one-time approximation for scheduling history, never calculation timing.
UPDATE processing.jobs SET started_at=updated_at
    WHERE started_at IS NULL AND attempt_id IS NOT NULL;
INSERT INTO processing.schema_version VALUES (7) ON CONFLICT DO NOTHING;

-- Direct calculation jobs carry input identity without an external plan record.
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS preparation jsonb;
INSERT INTO processing.schema_version VALUES (8) ON CONFLICT DO NOTHING;

-- Worker startup discards unfinished jobs; no persisted compatibility versions.
ALTER TABLE processing.jobs DROP COLUMN IF EXISTS job_format_version;
DROP TRIGGER IF EXISTS processing_claim_protocol ON processing.jobs;
DROP FUNCTION IF EXISTS processing.require_claim_protocol();
ALTER TABLE processing.jobs DROP COLUMN IF EXISTS minimum_claim_version;
INSERT INTO processing.schema_version VALUES (9) ON CONFLICT DO NOTHING;

-- Preparation belongs to jobs; retire the independent plan queue and records.
DROP TABLE IF EXISTS processing.plans;
DROP FUNCTION IF EXISTS processing.notify_plan_change();
ALTER TABLE processing.jobs DROP COLUMN IF EXISTS plan_id;
INSERT INTO processing.schema_version VALUES (10) ON CONFLICT DO NOTHING;

-- A computation owns execution and files; subscribers own public handles.
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS work_key text;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS execution_memory_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS required_disk_bytes bigint NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_work ON processing.jobs(work_key)
    WHERE work_key IS NOT NULL AND status IN ('queued','running');
CREATE TABLE IF NOT EXISTS processing.job_subscribers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    owner text NOT NULL,
    request_key text NOT NULL,
    request_hash text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text CHECK (status IN ('cancelling','cancelled','deleted')),
    presentation jsonb CHECK (octet_length(presentation::text) <= 32768),
    UNIQUE(owner,request_key)
);
CREATE INDEX IF NOT EXISTS subscribers_job ON processing.job_subscribers(job_id);
CREATE INDEX IF NOT EXISTS subscribers_owner ON processing.job_subscribers(owner,created_at DESC);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='processing'
               AND table_name='jobs' AND column_name='owner') THEN
        ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS request_hash text;
        INSERT INTO processing.job_subscribers
            (id,job_id,owner,request_key,request_hash,created_at,updated_at)
        SELECT id,id,owner,request_key,request_hash,created_at,updated_at FROM processing.jobs
        ON CONFLICT DO NOTHING;
        ALTER TABLE processing.jobs DROP COLUMN owner;
        ALTER TABLE processing.jobs DROP COLUMN request_key;
        ALTER TABLE processing.jobs DROP COLUMN request_hash;
    END IF;
END $$;

CREATE OR REPLACE VIEW processing.subscribed_jobs AS
SELECT s.id,s.owner,s.request_key,s.request_hash,s.presentation,s.job_id,
       j.created_at,s.created_at AS subscribed_at,
       greatest(s.updated_at,j.updated_at) AS updated_at,j.expires_at,
       CASE WHEN s.status='cancelling' AND j.status<>'cancelling' THEN 'cancelled'
            ELSE coalesce(s.status,j.status) END AS status,
       j.operation,CASE WHEN j.spec IS NULL THEN NULL ELSE j.summary END AS spec,
       j.reserved_bytes,j.attempt_id,j.lease_until,j.deadline_at,j.progress,j.preparation,
       CASE WHEN s.status IS NULL THEN j.artifact END AS artifact,
       CASE WHEN s.status IS NULL THEN j.error END AS error
FROM processing.job_subscribers s JOIN processing.jobs j ON j.id=s.job_id;

CREATE OR REPLACE FUNCTION processing.notify_job_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE subscriber_owner text;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.progress IS NOT DISTINCT FROM OLD.progress THEN RETURN NEW; END IF;
    FOR subscriber_owner IN SELECT DISTINCT owner FROM processing.job_subscribers
        WHERE job_id=NEW.id AND (status IS NULL OR status='cancelling') LOOP
        PERFORM pg_notify('eolab_processing_job_changes', subscriber_owner);
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER processing_job_change AFTER UPDATE OF status, progress ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.notify_job_change();
CREATE OR REPLACE FUNCTION processing.notify_subscriber_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_notify('eolab_processing_job_changes', NEW.owner);
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS processing_subscriber_change ON processing.job_subscribers;
CREATE TRIGGER processing_subscriber_change AFTER INSERT OR UPDATE ON processing.job_subscribers
FOR EACH ROW EXECUTE FUNCTION processing.notify_subscriber_change();
INSERT INTO processing.schema_version VALUES (11) ON CONFLICT DO NOTHING;

-- Wake claimers after execution stops or cleanup releases retained disk space.
CREATE OR REPLACE FUNCTION processing.notify_execution_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    IF (OLD.status IN ('running','cancelling') AND NEW.status NOT IN ('running','cancelling'))
       OR NEW.reserved_bytes < OLD.reserved_bytes THEN
        PERFORM pg_notify('eolab_processing_jobs', '');
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS processing_capacity_change ON processing.jobs;
CREATE TRIGGER processing_capacity_change AFTER UPDATE OF status,reserved_bytes ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.notify_execution_capacity();
INSERT INTO processing.schema_version VALUES (12) ON CONFLICT DO NOTHING;
INSERT INTO processing.schema_version VALUES (13) ON CONFLICT DO NOTHING;

-- Resource accounting need not visit cleaned history with no disk reservation.
CREATE INDEX IF NOT EXISTS jobs_reserved_bytes ON processing.jobs(reserved_bytes)
    WHERE reserved_bytes>0;
CREATE INDEX IF NOT EXISTS jobs_pending_cleanup ON processing.jobs(updated_at)
    WHERE status NOT IN ('queued','running','cancelling','ready')
      AND (reserved_bytes>0 OR spec IS NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_cleaned_history ON processing.jobs(updated_at)
    WHERE reserved_bytes=0 AND spec IS NULL
      AND status NOT IN ('queued','running','cancelling','ready');
INSERT INTO processing.schema_version VALUES (14) ON CONFLICT DO NOTHING;
