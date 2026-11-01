BEGIN;

SET LOCAL search_path TO pgstac, public;

DO $migration$
BEGIN
    IF pgstac.get_version() <> '0.9.12' THEN
        RAISE EXCEPTION 'EOLab catalog migrations require pgSTAC 0.9.12, found %',
            pgstac.get_version();
    END IF;
END;
$migration$;

-- Return the column's CHECK range from expressions captured by the query.
-- A concurrent widener can replace a constraint while deparsing waits for DDL.
-- Looking its old OID up again would return NULL and falsely imply no bounds.
CREATE OR REPLACE FUNCTION get_tstz_constraint(reloid oid, colname text) RETURNS tstzrange AS $$
DECLARE
    expr text := NULL;
    m text[];
    ts_lower timestamptz := NULL;
    ts_upper timestamptz := NULL;
    lower_inclusive text := '[';
    upper_inclusive text := ']';
    ts timestamptz;
BEGIN
    SELECT INTO expr
        string_agg(def, ' AND ')
    FROM pg_constraint JOIN LATERAL pg_get_expr(conbin, conrelid) AS def ON TRUE
    WHERE
        conrelid = reloid
        AND contype = 'c'
        AND def LIKE '%' || colname || '%'
    ;

    IF expr IS NULL THEN
        RETURN NULL;
    END IF;

    RAISE DEBUG 'Constraint expression for % on %: %', colname, reloid::regclass, expr;
    -- collect all constraints for the specified column
    FOR m IN SELECT regexp_matches(expr, '[ (]' || colname || $expr$\s*([<>=]{1,2})\s*'([0-9 :.+\-]+)'$expr$, 'g') LOOP
        ts := m[2]::timestamptz;
        IF m[1] IN ('>', '>=')
        THEN
            IF ts_lower IS NULL OR ts > ts_lower OR (ts = ts_lower AND m[1] = '>') THEN
                ts_lower := ts;
                lower_inclusive := CASE WHEN m[1] = '>' THEN '(' ELSE '[' END;
            END IF;
        ELSIF m[1] IN ('<', '<=')
        THEN
            IF ts_upper IS NULL OR ts < ts_upper OR (ts = ts_upper AND m[1] = '<') THEN
                ts_upper := ts;
                upper_inclusive := CASE WHEN m[1] = '<' THEN ')' ELSE ']' END;
            END IF;
        END IF;
    END LOOP;
    RAISE DEBUG 'Constraint % for %: % %', colname, reloid::regclass, ts_lower, ts_upper;
    RETURN tstzrange(ts_lower, ts_upper, lower_inclusive || upper_inclusive);
END;
$$ LANGUAGE plpgsql STRICT STABLE;

-- Return the partition for a batch, widening its date constraints safely.
-- Covered batches need no maintenance lock. Creation and widening take parent
-- locks before child DDL/statistics locks, then read fresh physical bounds.
CREATE OR REPLACE FUNCTION check_partition(
    _collection text,
    _dtrange tstzrange,
    _edtrange tstzrange
) RETURNS text AS $$
DECLARE
    c RECORD;
    pm RECORD;
    _partition_name text;
    _partition_dtrange tstzrange;
    _constraint_dtrange tstzrange;
    _constraint_edtrange tstzrange;
    new_partition boolean;
    q text;
BEGIN
    SELECT * INTO c FROM collections WHERE id = _collection;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Collection % does not exist', _collection
            USING ERRCODE = 'foreign_key_violation',
                HINT = 'Make sure collection exists before adding items';
    END IF;

    SELECT partition_name, partition_range
    INTO _partition_name, _partition_dtrange
    FROM partition_name(_collection, lower(_dtrange));
    IF NOT _partition_dtrange @> _dtrange THEN
        RAISE EXCEPTION 'dtrange % is greater than the partition size % for collection %',
            _dtrange, c.partition_trunc, _collection;
    END IF;

    SELECT ps.partition, m.constraint_dtrange, m.constraint_edtrange
    INTO pm
    FROM partition_stats ps
    JOIN LATERAL partition_catalog_meta(ps.partition) m ON true
    WHERE ps.partition = _partition_name;
    IF FOUND AND pm.constraint_dtrange @> _dtrange
            AND pm.constraint_edtrange @> _edtrange THEN
        RETURN pm.partition;
    END IF;

    -- The staging trigger chooses ACCESS EXCLUSIVE upfront for a batch with
    -- any new partition. Direct single-partition callers use the same order.
    LOCK TABLE ONLY items IN EXCLUSIVE MODE;
    new_partition := partition_oid(_partition_name) IS NULL;
    IF new_partition THEN
        LOCK TABLE ONLY items IN ACCESS EXCLUSIVE MODE;
        IF c.partition_trunc IS NULL THEN
            q := format(
                $q$
                    CREATE TABLE IF NOT EXISTS %I PARTITION OF items
                        FOR VALUES IN (%L);
                    CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (id);
                    GRANT ALL ON %I TO pgstac_ingest;
                $q$,
                _partition_name, _collection,
                _partition_name || '_pk', _partition_name, _partition_name
            );
        ELSE
            q := format(
                $q$
                    CREATE TABLE IF NOT EXISTS %I PARTITION OF items
                        FOR VALUES IN (%L) PARTITION BY RANGE (datetime);
                    CREATE TABLE IF NOT EXISTS %I PARTITION OF %I
                        FOR VALUES FROM (%L) TO (%L);
                    CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (id);
                    GRANT ALL ON %I TO pgstac_ingest;
                $q$,
                format('_items_%s', c.key), _collection,
                _partition_name, format('_items_%s', c.key),
                lower(_partition_dtrange), upper(_partition_dtrange),
                _partition_name || '_pk', _partition_name, _partition_name
            );
        END IF;
        EXECUTE q;
    END IF;

    -- Acquire outside create_table_constraints' exception block: a failed
    -- validation must not release DDL protection and continue to statistics.
    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', _partition_name);

    -- This is a separate command after the lock wait, so READ COMMITTED sees
    -- another creator's committed bounds rather than the pre-wait snapshot.
    SELECT m.constraint_dtrange, m.constraint_edtrange
    INTO pm
    FROM partition_catalog_meta(_partition_name) m;
    IF new_partition THEN
        _constraint_dtrange := _dtrange;
        _constraint_edtrange := _edtrange;
    ELSE
        _constraint_dtrange := range_merge(pm.constraint_dtrange, _dtrange);
        _constraint_edtrange := range_merge(pm.constraint_edtrange, _edtrange);
    END IF;

    IF new_partition OR NOT (
        pm.constraint_dtrange @> _dtrange
        AND pm.constraint_edtrange @> _edtrange
    ) THEN
        PERFORM drop_table_constraints(_partition_name);
        PERFORM run_or_queue(format(
            'SELECT create_table_constraints(%L, %L, %L);',
            _partition_name, _constraint_dtrange, _constraint_edtrange
        ));
    END IF;
    PERFORM maintain_partitions(_partition_name);
    -- Keep new partitions discoverable before commit even when optional
    -- constraint/statistics maintenance is queued.
    IF NOT update_partition_stats_q(_partition_name, true) THEN
        INSERT INTO partition_stats (partition, collection, partition_dtrange)
        VALUES (_partition_name, _collection, _partition_dtrange)
        ON CONFLICT (partition) DO UPDATE
            SET collection = EXCLUDED.collection,
                partition_dtrange = EXCLUDED.partition_dtrange
            WHERE partition_stats.collection IS DISTINCT FROM EXCLUDED.collection
                OR partition_stats.partition_dtrange
                    IS DISTINCT FROM EXCLUDED.partition_dtrange;
    END IF;
    RETURN _partition_name;
END;
$$ LANGUAGE PLPGSQL SECURITY DEFINER SET SEARCH_PATH TO pgstac, public;

-- Publish bulk items through the existing staging trigger. Determine a batch's
-- schema-maintenance lock before any partition takes DDL/statistics locks.
CREATE OR REPLACE FUNCTION items_staging_triggerfunc() RETURNS TRIGGER AS $$
DECLARE
    part text;
    ts timestamptz := clock_timestamp();
    nrows int;
    maintenance_needed boolean;
    creation_needed boolean;
BEGIN
    RAISE NOTICE 'Creating Partitions. %', clock_timestamp() - ts;

    -- Covered batches keep the ordinary concurrent DML path. Coordinate only
    -- schema maintenance, before it can hold child-table or statistics locks.
    WITH requested AS (
        SELECT n.content->>'collection' AS collection,
            stac_daterange(n.content->'properties') AS dates,
            c.partition_trunc
        FROM newdata n
        JOIN collections c ON c.id = n.content->>'collection'
    ), ranges AS (
        SELECT collection,
            COALESCE(date_trunc(partition_trunc, lower(dates)), '-infinity') AS period,
            tstzrange(min(lower(dates)), max(lower(dates)), '[]') AS dates,
            tstzrange(min(upper(dates)), max(upper(dates)), '[]') AS end_dates
        FROM requested
        GROUP BY collection, period
    )
    SELECT COALESCE(bool_or(
        ps.partition IS NULL
        OR m.collection IS NULL
        OR NOT (m.constraint_dtrange @> r.dates
                AND m.constraint_edtrange @> r.end_dates)
    ), false)
    INTO maintenance_needed
    FROM ranges r
    CROSS JOIN LATERAL partition_name(r.collection, lower(r.dates)) p
    LEFT JOIN partition_stats ps ON ps.partition = p.partition_name
    LEFT JOIN LATERAL partition_catalog_meta(p.partition_name) m ON true;

    IF maintenance_needed THEN
        LOCK TABLE ONLY items IN EXCLUSIVE MODE;
        -- Recheck after waiting. A batch that needs any new partition must
        -- take the parent's strongest lock before touching its first child.
        WITH requested AS (
            SELECT n.content->>'collection' AS collection,
                stac_daterange(n.content->'properties') AS dates,
                c.partition_trunc
            FROM newdata n
            JOIN collections c ON c.id = n.content->>'collection'
        ), ranges AS (
            SELECT collection,
                COALESCE(date_trunc(partition_trunc, lower(dates)), '-infinity') AS period,
                tstzrange(min(lower(dates)), max(lower(dates)), '[]') AS dates,
                tstzrange(min(upper(dates)), max(upper(dates)), '[]') AS end_dates
            FROM requested
            GROUP BY collection, period
        )
        SELECT EXISTS (
            SELECT 1 FROM ranges r
            CROSS JOIN LATERAL partition_name(r.collection, lower(r.dates)) p
            WHERE partition_oid(p.partition_name) IS NULL
        )
        INTO creation_needed;
        IF creation_needed THEN
            LOCK TABLE ONLY items IN ACCESS EXCLUSIVE MODE;
        END IF;
    END IF;

    FOR part IN WITH t AS (
        SELECT
            n.content->>'collection' as collection,
            stac_daterange(n.content->'properties') as dtr,
            partition_trunc
        FROM newdata n JOIN collections ON (n.content->>'collection'=collections.id)
    ), p AS (
        SELECT
            collection,
            COALESCE(date_trunc(partition_trunc::text, lower(dtr)),'-infinity') as d,
            tstzrange(min(lower(dtr)),max(lower(dtr)),'[]') as dtrange,
            tstzrange(min(upper(dtr)),max(upper(dtr)),'[]') as edtrange
        FROM t
        GROUP BY 1,2
    -- Ordered: check_partition holds DDL and row locks until commit.
    ) SELECT check_partition(collection, dtrange, edtrange) FROM (
        SELECT * FROM p ORDER BY collection, d
    ) ordered LOOP
        RAISE NOTICE 'Partition %', part;
    END LOOP;

    RAISE NOTICE 'Creating temp table with data to be added. %', clock_timestamp() - ts;
    DROP TABLE IF EXISTS tmpdata;
    CREATE TEMP TABLE tmpdata ON COMMIT DROP AS
    SELECT
        (content_dehydrate(content)).*
    FROM newdata;
    GET DIAGNOSTICS nrows = ROW_COUNT;
    RAISE NOTICE 'Added % rows to tmpdata. %', nrows, clock_timestamp() - ts;

    RAISE NOTICE 'Doing the insert. %', clock_timestamp() - ts;
    IF TG_TABLE_NAME = 'items_staging' THEN
        INSERT INTO items
        SELECT * FROM tmpdata;
        GET DIAGNOSTICS nrows = ROW_COUNT;
        RAISE NOTICE 'Inserted % rows to items. %', nrows, clock_timestamp() - ts;
    ELSIF TG_TABLE_NAME = 'items_staging_ignore' THEN
        INSERT INTO items
        SELECT * FROM tmpdata
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS nrows = ROW_COUNT;
        RAISE NOTICE 'Inserted % rows to items. %', nrows, clock_timestamp() - ts;
    ELSIF TG_TABLE_NAME = 'items_staging_upsert' THEN
        -- Locked in a fixed order first, so concurrent upserts over an
        -- overlapping id set cannot deadlock. A bare DELETE gives no ordering;
        -- ORDER BY ... FOR UPDATE does, because LockRows sits above the sort.
        WITH locked AS (
            SELECT o.collection, o.id
            FROM tmpdata s
                JOIN items o ON (o.id = s.id AND o.collection = s.collection)
            WHERE o IS DISTINCT FROM s
            ORDER BY o.collection, o.id
            FOR UPDATE OF o
        )
        DELETE FROM items i
        USING locked l
        WHERE i.collection = l.collection AND i.id = l.id
        ;
        GET DIAGNOSTICS nrows = ROW_COUNT;
        RAISE NOTICE 'Deleted % rows from items. %', nrows, clock_timestamp() - ts;
        INSERT INTO items AS t
        SELECT * FROM tmpdata
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS nrows = ROW_COUNT;
        RAISE NOTICE 'Inserted % rows to items. %', nrows, clock_timestamp() - ts;
    END IF;

    RAISE NOTICE 'Deleting data from staging table. %', clock_timestamp() - ts;
    EXECUTE format('DELETE FROM %I', TG_TABLE_NAME);
    RAISE NOTICE 'Done. %', clock_timestamp() - ts;

    RETURN NULL;

END;
$$ LANGUAGE PLPGSQL;

COMMIT;
