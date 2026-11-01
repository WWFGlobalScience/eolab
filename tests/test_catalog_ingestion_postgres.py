"""Exercise concurrent pgSTAC ingestion against an explicitly disposable database."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import time
from typing import Any, Iterator
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
import pytest

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "catalog/migrations/0007_partition_maintenance_locking.sql"
)
BASE_TIME = datetime(2020, 1, 1, tzinfo=timezone.utc)
UNSAFE_NOTICES = {"40P01", "23514"}
CONTROLLER_APPLICATION_NAME = "catalog-barrier-controller"


@dataclass(frozen=True)
class CatalogDatabase:
    """Identify the disposable database and its original public function contracts.

    Attributes:
        dsn: Explicit connection string whose database name passed the safety guard.
        original_contracts: Signatures, privileges and execution attributes before
            applying the application migration.
    """

    dsn: str
    original_contracts: list[tuple[Any, ...]]


@dataclass(frozen=True)
class IngestionResult:
    """Record one real SQL ingestion outcome and every server warning it emitted.

    Attributes:
        application_name: Unique writer identity visible in PostgreSQL diagnostics.
        error: SQLSTATE and message when PostgreSQL rejected the transaction.
        notices: SQLSTATE and message pairs delivered by the connection notice handler.
    """

    application_name: str
    error: tuple[str | None, str] | None
    notices: tuple[tuple[str | None, str | None], ...]


def function_contracts(connection: psycopg.Connection[Any]) -> list[tuple[Any, ...]]:
    """Return the existing ingestion functions' signatures and execution privileges.

    Args:
        connection: Open connection to the guarded test database.

    Returns:
        Stable catalog rows for the existing functions the migration may replace.
    """
    return connection.execute("""
        SELECT p.proname, pg_get_function_identity_arguments(p.oid),
               pg_get_function_result(p.oid), p.prosecdef, p.provolatile,
               p.proisstrict, p.proparallel, p.proconfig, p.proacl::text, p.proowner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'pgstac'
          AND p.proname IN (
              'check_partition', 'items_staging_triggerfunc', 'get_tstz_constraint'
          )
        ORDER BY p.proname
        """).fetchall()


@pytest.fixture(scope="session")
def catalog_database() -> CatalogDatabase:
    """Apply the fix twice only to an explicitly selected disposable pgSTAC database.

    Returns:
        Guarded connection details and the original ingestion function contracts.

    Raises:
        pytest.fail.Exception: If either the requested or connected database is unsafe,
            the pinned pgSTAC version is absent, or the fix file is missing.
    """
    dsn = os.environ.get("EOLAB_CATALOG_TEST_DSN")
    if dsn is None:
        pytest.skip("Run scripts/test_catalog_postgres.py for real pgSTAC tests")
    if (
        not psycopg.conninfo.conninfo_to_dict(dsn)
        .get("dbname", "")
        .startswith("eolab_catalog_test_")
    ):
        pytest.fail("Catalog tests require an explicit eolab_catalog_test_ database")
    with psycopg.connect(dsn, autocommit=True) as connection:
        if not connection.info.dbname.startswith("eolab_catalog_test_"):
            pytest.fail("The connected catalog database must be disposable")
        assert connection.execute("SELECT pgstac.get_version()").fetchone() == (
            "0.9.12",
        )
        contracts = function_contracts(connection)
        assert len(contracts) == 3
        if os.environ.get("EOLAB_CATALOG_TEST_BASELINE") != "1":
            if not MIGRATION.is_file():
                pytest.fail(f"Missing catalog migration: {MIGRATION.name}")
            migration = MIGRATION.read_text(encoding="utf-8")
            connection.execute(migration, prepare=False)
            connection.execute(migration, prepare=False)
    return CatalogDatabase(dsn, contracts)


@contextmanager
def collection(database: CatalogDatabase, *, monthly: bool = False) -> Iterator[str]:
    """Create and remove one test-owned STAC collection after its connections close.

    Args:
        database: Guarded disposable database containing pgSTAC.
        monthly: Partition observations by month for the mixed maintenance case.

    Yields:
        Unique collection identity used by the real pgSTAC ingestion functions.
    """
    identifier = "catalog-ingestion-" + uuid4().hex
    document = {
        "type": "Collection",
        "stac_version": "1.0.0",
        "id": identifier,
        "description": "Disposable concurrent ingestion fixture",
        "license": "other",
        "extent": {
            "spatial": {"bbox": [[0, 0, 1, 1]]},
            "temporal": {"interval": [[None, None]]},
        },
        "links": [],
    }
    with psycopg.connect(database.dsn, autocommit=True) as connection:
        connection.execute("SET search_path TO pgstac, public")
        connection.execute("SELECT pgstac.create_collection(%s)", (Jsonb(document),))
        if monthly:
            connection.execute(
                "UPDATE pgstac.collections SET partition_trunc='month' WHERE id=%s",
                (identifier,),
            )
    try:
        yield identifier
    finally:
        with psycopg.connect(database.dsn, autocommit=True) as connection:
            connection.execute("SELECT pgstac.delete_collection(%s)", (identifier,))


def items(identifier: str, prefix: str, first: int, last: int) -> list[dict[str, Any]]:
    """Create 100 distinct valid STAC Items spanning the requested relative hours.

    Args:
        identifier: Owning collection identity.
        prefix: Unique prefix for this batch's item identifiers.
        first: Earliest hour relative to January 1, 2020 UTC.
        last: Latest hour relative to January 1, 2020 UTC.

    Returns:
        One complete batch with precise UTC timestamps and a simple valid footprint.
    """
    return [
        {
            "type": "Feature",
            "stac_version": "1.0.0",
            "id": f"{prefix}-{index:03}",
            "collection": identifier,
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            },
            "bbox": [0, 0, 1, 1],
            "properties": {
                "datetime": (
                    BASE_TIME + timedelta(hours=first + (last - first) * index / 99)
                ).isoformat()
            },
            "assets": {},
            "links": [],
        }
        for index in range(100)
    ]


def ingest(
    database: CatalogDatabase,
    application_name: str,
    batch: list[dict[str, Any]],
    *,
    use_queue: bool = False,
) -> IngestionResult:
    """Execute one actual pgSTAC upsert transaction and retain warnings and failures.

    Args:
        database: Guarded disposable database.
        application_name: Writer identity for coordinating test-only SQL barriers.
        batch: Complete STAC batch, including collection and unique item identities.
        use_queue: Defer upstream's optional index and statistics maintenance.

    Returns:
        The transaction's SQL error, if any, and its synchronous server notices.
    """
    notices: list[tuple[str | None, str | None]] = []

    def notice(diagnostic: psycopg.errors.Diagnostic) -> None:
        """Retain a server notice before its connection-owned diagnostic expires.

        Args:
            diagnostic: Server-provided SQLSTATE and primary message.
        """
        notices.append((diagnostic.sqlstate, diagnostic.message_primary))

    error = None
    with psycopg.connect(
        database.dsn, application_name=application_name, autocommit=True
    ) as connection:
        connection.add_notice_handler(notice)
        connection.execute("SET statement_timeout='20s'")
        connection.execute("SET deadlock_timeout='100ms'")
        connection.execute(
            "SELECT set_config('pgstac.use_queue', %s, false)",
            ("true" if use_queue else "false",),
        )
        try:
            connection.execute("SELECT pgstac.upsert_items(%s)", (Jsonb(batch),))
        except psycopg.Error as failure:
            error = failure.sqlstate, str(failure)
        connection.execute("SELECT pg_stat_force_next_flush()")
    return IngestionResult(application_name, error, tuple(notices))


def wait_for_writers(
    connection: psycopg.Connection[Any],
    names: list[str],
    blocker: str | None = None,
    *,
    any_writer: bool = False,
) -> None:
    """Wait for the selected writers to block at a real SQL lock boundary.

    Args:
        connection: Independent autocommit observer connection.
        names: Writer application names that must all be waiting on locks.
        blocker: Optional writer name that must appear among their blockers.
        any_writer: Return when any named writer reaches the requested blocker.

    Raises:
        AssertionError: If the required SQL schedule is not reached in ten seconds.
    """
    deadline = time.monotonic() + 10
    rows: list[tuple[Any, ...]] = []
    while time.monotonic() < deadline:
        connection.execute("SELECT pg_stat_clear_snapshot()")
        rows = connection.execute(
            """
            SELECT a.application_name, a.wait_event_type,
                   ARRAY(SELECT b.application_name FROM pg_stat_activity b
                         WHERE b.pid = ANY(pg_blocking_pids(a.pid)))
            FROM pg_stat_activity a WHERE a.application_name = ANY(%s)
            """,
            (names,),
        ).fetchall()
        matches = [
            row[1] == "Lock" and (blocker is None or blocker in row[2]) for row in rows
        ]
        if (any_writer and any(matches)) or (len(rows) == len(names) and all(matches)):
            return
        time.sleep(0.01)
    raise AssertionError(f"Writers did not reach the required lock schedule: {rows}")


@contextmanager
def statistics_barriers(
    database: CatalogDatabase, names: list[str]
) -> Iterator[tuple[psycopg.Connection[Any], list[int]]]:
    """Pause selected writers after the real partition-statistics statement locks rows.

    The test trigger changes no production function or data semantics. Statement
    triggers also run when an ON CONFLICT statement changes zero rows, which lets
    the schedule expose the original no-op statistics-row lock inversion.

    Args:
        database: Guarded disposable database.
        names: Writer identities paused on corresponding controller-owned keys.

    Yields:
        Autocommit controller and advisory keys that release the selected writers.
    """
    suffix = uuid4().hex
    function = "pause_stats_" + suffix
    keys = [int(suffix[:12], 16) + index for index in range(len(names))]
    with psycopg.connect(
        database.dsn,
        application_name=CONTROLLER_APPLICATION_NAME,
        autocommit=True,
    ) as control:
        clauses = "\n".join(
            f"IF current_setting('application_name') = {sql.Literal(name).as_string(control)} THEN PERFORM pg_advisory_xact_lock({key}); END IF;"
            for name, key in zip(names, keys, strict=True)
        )
        control.execute("CREATE SCHEMA IF NOT EXISTS catalog_test")
        control.execute(
            sql.SQL(
                "CREATE FUNCTION catalog_test.{}() RETURNS trigger LANGUAGE plpgsql "
                "AS $body$ BEGIN " + clauses + " RETURN NULL; END; $body$"
            ).format(sql.Identifier(function))
        )
        control.execute(
            sql.SQL(
                "CREATE TRIGGER {} AFTER INSERT ON pgstac.partition_stats "
                "FOR EACH STATEMENT EXECUTE FUNCTION catalog_test.{}()"
            ).format(sql.Identifier(function), sql.Identifier(function))
        )
        for key in keys:
            control.execute("SELECT pg_advisory_lock(%s)", (key,))
        try:
            yield control, keys
        finally:
            control.execute("SELECT pg_advisory_unlock_all()")
            control.execute(
                sql.SQL("DROP TRIGGER {} ON pgstac.partition_stats").format(
                    sql.Identifier(function)
                )
            )
            control.execute(
                sql.SQL("DROP FUNCTION catalog_test.{}()").format(
                    sql.Identifier(function)
                )
            )


def deadlocks(connection: psycopg.Connection[Any]) -> int:
    """Return a fresh deadlock counter for this disposable database.

    Args:
        connection: Observer connection after writer statistics have been flushed.

    Returns:
        PostgreSQL's database-level deadlock count, including caught deadlocks.
    """
    connection.execute("SELECT pg_stat_clear_snapshot()")
    row = connection.execute(
        "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()"
    ).fetchone()
    assert row is not None
    return int(row[0])


def assert_complete(
    database: CatalogDatabase,
    identifier: str,
    batches: list[list[dict[str, Any]]],
    results: list[IngestionResult],
    initial_deadlocks: int,
    *,
    deferred_constraints: bool = False,
) -> None:
    """Require committed items, validated constraints and no hidden concurrency failures.

    Args:
        database: Guarded disposable database.
        identifier: Collection whose complete expected item set is checked.
        batches: Every batch that should have committed, including seed data.
        results: Real SQL outcomes from the concurrent writers.
        initial_deadlocks: Counter measured before running these writers.
        deferred_constraints: Check queued maintenance and published partition identity
            instead of requiring optional CHECK maintenance to have run already.
    """
    diagnostics = [
        (
            result.application_name,
            result.error,
            tuple(
                notice
                for notice in result.notices
                if notice[0] in UNSAFE_NOTICES
                or "Issue Altering Constraints" in (notice[1] or "")
            ),
        )
        for result in results
    ]
    if any(error is not None or notices for _, error, notices in diagnostics):
        print(f"Catalog ingestion failures: {diagnostics!r}", flush=True)
    assert all(result.error is None for result in results), results
    assert not [
        (result.application_name, notice)
        for result in results
        for notice in result.notices
        if notice[0] in UNSAFE_NOTICES
        or "Issue Altering Constraints" in (notice[1] or "")
    ], results
    with psycopg.connect(database.dsn, autocommit=True) as connection:
        assert deadlocks(connection) == initial_deadlocks
        expected = {item["id"] for batch in batches for item in batch}
        actual = {
            row[0]
            for row in connection.execute(
                "SELECT id FROM pgstac.items WHERE collection=%s", (identifier,)
            )
        }
        assert actual == expected
        if deferred_constraints:
            assert (
                connection.execute(
                    "SELECT count(*) FROM pgstac.partition_stats WHERE collection=%s",
                    (identifier,),
                ).fetchone()[0]
                > 0
            )
            assert (
                connection.execute(
                    "SELECT count(*) FROM pgstac.query_queue"
                ).fetchone()[0]
                > 0
            )
            return
        constraints = connection.execute(
            """
            SELECT c.conname, c.convalidated
            FROM pgstac.partition_stats ps
            JOIN pg_class r ON r.relname=ps.partition
            JOIN pg_namespace n ON n.oid=r.relnamespace AND n.nspname='pgstac'
            JOIN pg_constraint c ON c.conrelid=r.oid AND c.contype='c'
            WHERE ps.collection=%s
            """,
            (identifier,),
        ).fetchall()
        partition_count = connection.execute(
            "SELECT count(*) FROM pgstac.partition_stats WHERE collection=%s",
            (identifier,),
        ).fetchone()[0]
        assert len(constraints) >= partition_count > 0
        assert all(validated for _, validated in constraints), constraints


def test_migration_repeats_without_changing_ingestion_contracts(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep upstream signatures and privileges while replaying the migration twice.

    Args:
        catalog_database: Database whose fixture applied the migration twice.
    """
    with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
        assert function_contracts(connection) == catalog_database.original_contracts
        public_definers = connection.execute("""
            SELECT p.proname FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
            CROSS JOIN LATERAL aclexplode(
                coalesce(p.proacl, acldefault('f', p.proowner))) a
            WHERE n.nspname='pgstac' AND p.prosecdef
              AND a.grantee=0 AND a.privilege_type='EXECUTE'
            """).fetchall()
        assert public_definers == []


def test_existing_ingest_role_can_create_and_widen_partitions(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep cold creation and widening available through the existing ingestion role.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        batches = [
            items(identifier, "initial", 10, 20),
            items(identifier, "wider", 0, 30),
        ]
        notices: list[tuple[str | None, str | None]] = []

        def notice(diagnostic: psycopg.errors.Diagnostic) -> None:
            """Retain warnings emitted while the connection acts as pgstac_ingest.

            Args:
                diagnostic: Server-provided warning SQLSTATE and primary message.
            """
            notices.append((diagnostic.sqlstate, diagnostic.message_primary))

        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            initial = deadlocks(connection)
            connection.add_notice_handler(notice)
            connection.execute("SET ROLE pgstac_ingest")
            for batch in batches:
                connection.execute("SELECT pgstac.upsert_items(%s)", (Jsonb(batch),))
            connection.execute("RESET ROLE")
            connection.execute("SELECT pg_stat_force_next_flush()")
        result = IngestionResult("pgstac_ingest", None, tuple(notices))
        assert_complete(catalog_database, identifier, batches, [result], initial)


def test_parallel_cold_ingestion(catalog_database: CatalogDatabase) -> None:
    """Reproduce cold-partition stale bounds with four real 100-item writers.

    Args:
        catalog_database: Guarded database with either baseline or patched pgSTAC.
    """
    with collection(catalog_database) as identifier:
        prefix = uuid4().hex
        names = [f"{prefix}-{letter}" for letter in "abcd"]
        batches = [
            items(identifier, "a", 10, 19),
            items(identifier, "b", 0, 9),
            items(identifier, "c", 20, 29),
            items(identifier, "d", 30, 39),
        ]
        with statistics_barriers(catalog_database, names[:2]) as (control, keys):
            initial = deadlocks(control)
            scheduling_failure: AssertionError | None = None
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(ingest, catalog_database, names[0], batches[0])]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.append(
                        pool.submit(ingest, catalog_database, names[1], batches[1])
                    )
                    wait_for_writers(control, names[1:2], names[0])
                    control.execute("SELECT pg_advisory_unlock(%s)", (keys[0],))
                    wait_for_writers(control, names[1:2], CONTROLLER_APPLICATION_NAME)
                    # B's stale constraint failure releases its inner DDL lock.
                    # Fresh C/D now attempt existing-partition maintenance while
                    # B still holds the real statistics row lock.
                    futures.extend(
                        pool.submit(ingest, catalog_database, name, batch)
                        for name, batch in zip(names[2:], batches[2:], strict=True)
                    )
                    wait_for_writers(control, names[2:], names[1], any_writer=True)
                except AssertionError as failure:
                    # A deadlock victim can exit before the next barrier probe.
                    # Preserve all real SQL outcomes before reporting the schedule.
                    scheduling_failure = failure
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            observed_deadlocks = deadlocks(control) - initial
            if scheduling_failure is not None:
                print(
                    f"Cold ingestion schedule failed: {scheduling_failure}; "
                    f"database_deadlocks={observed_deadlocks}; "
                    f"writer_errors={[(result.application_name, result.error) for result in results]!r}",
                    flush=True,
                )
            if observed_deadlocks > 0 or any(
                (result.error is not None and result.error[0] == "40P01")
                or any(notice[0] == "40P01" for notice in result.notices)
                for result in results
            ):
                print(
                    "CATALOG_BASELINE_DEADLOCK_REPRODUCED "
                    f"database_deadlocks={observed_deadlocks} "
                    f"writer_errors={[result.error for result in results]}",
                    flush=True,
                )
            assert_complete(catalog_database, identifier, batches, results, initial)
            if scheduling_failure is not None:
                raise scheduling_failure


def test_parallel_widening_preserves_committed_bounds(
    catalog_database: CatalogDatabase,
) -> None:
    """Widen one existing partition using fresh committed bounds after waiting.

    Args:
        catalog_database: Guarded database containing the reviewed migration.
    """
    with collection(catalog_database) as identifier:
        seed = items(identifier, "seed", 20, 29)
        assert ingest(catalog_database, "seed", seed).error is None
        batches = [
            items(identifier, str(index), index * 10, index * 10 + 9)
            for index in range(4)
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with psycopg.connect(catalog_database.dsn, autocommit=True) as control:
            initial = deadlocks(control)
            partition = control.execute(
                "SELECT partition FROM pgstac.partition_stats WHERE collection=%s",
                (identifier,),
            ).fetchone()[0]
            control.execute("BEGIN")
            control.execute(
                sql.SQL("LOCK TABLE pgstac.{} IN SHARE MODE").format(
                    sql.Identifier(partition)
                )
            )
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [
                    pool.submit(ingest, catalog_database, name, batch)
                    for name, batch in zip(names, batches, strict=True)
                ]
                try:
                    wait_for_writers(control, names)
                finally:
                    control.execute("ROLLBACK")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database, identifier, [seed, *batches], results, initial
            )


def test_covered_batches_keep_four_writers_without_a_maintenance_gate(
    catalog_database: CatalogDatabase,
) -> None:
    """Allow four covered-range writers to reach their existing statistics-row wait.

    Args:
        catalog_database: Guarded database containing the reviewed migration.
    """
    with collection(catalog_database) as identifier:
        seed = items(identifier, "seed", 0, 100)
        assert ingest(catalog_database, "seed", seed).error is None
        batches = [
            items(identifier, str(index), index * 10, index * 10 + 9)
            for index in range(4)
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with statistics_barriers(catalog_database, names[:1]) as (control, _):
            initial = deadlocks(control)
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(ingest, catalog_database, names[0], batches[0])]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.extend(
                        pool.submit(ingest, catalog_database, name, batch)
                        for name, batch in zip(names[1:], batches[1:], strict=True)
                    )
                    wait_for_writers(control, names)
                    strong_locks = control.execute(
                        """
                        SELECT a.application_name, l.mode FROM pg_locks l
                        JOIN pg_stat_activity a ON a.pid=l.pid
                        WHERE a.application_name=ANY(%s)
                          AND l.relation='pgstac.items'::regclass
                          AND l.mode NOT IN ('AccessShareLock','RowShareLock','RowExclusiveLock')
                        """,
                        (names,),
                    ).fetchall()
                    assert strong_locks == []
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database, identifier, [seed, *batches], results, initial
            )


def test_mixed_existing_and_new_partitions_take_the_parent_lock_first(
    catalog_database: CatalogDatabase,
) -> None:
    """Avoid upgrading the parent lock after locking an existing monthly partition.

    Args:
        catalog_database: Guarded database containing the reviewed migration.
    """
    with collection(catalog_database, monthly=True) as identifier:
        january = items(identifier, "january", 24, 48)
        february = items(identifier, "february", 32 * 24, 34 * 24)
        for seed in (january, february):
            assert ingest(catalog_database, "seed", seed).error is None
        batches = [
            [
                *items(identifier, "widen", 0, 72),
                *items(identifier, "new", 61 * 24, 62 * 24),
            ],
            *[
                items(identifier, f"covered-{index}", 32 * 24 + index, 33 * 24 + index)
                for index in range(3)
            ],
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with statistics_barriers(catalog_database, names[:1]) as (control, _):
            initial = deadlocks(control)
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures: list[Future[IngestionResult]] = [
                    pool.submit(ingest, catalog_database, names[0], batches[0])
                ]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.extend(
                        pool.submit(ingest, catalog_database, name, batch)
                        for name, batch in zip(names[1:], batches[1:], strict=True)
                    )
                    wait_for_writers(control, names[1:], names[0])
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database,
                identifier,
                [january, february, *batches],
                results,
                initial,
            )


def test_existing_partition_publishes_its_missing_statistics_identity(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep an existing physical partition searchable when its identity is unpublished.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        seed = items(identifier, "seed", 0, 100)
        assert ingest(catalog_database, "seed", seed).error is None
        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            initial = deadlocks(connection)
            connection.execute(
                "DELETE FROM pgstac.partition_stats WHERE collection=%s",
                (identifier,),
            )
        batch = items(identifier, "covered", 10, 20)
        result = ingest(catalog_database, "publish-identity", batch)
        assert_complete(catalog_database, identifier, [seed, batch], [result], initial)


def test_queued_maintenance_still_publishes_concurrent_items(
    catalog_database: CatalogDatabase,
) -> None:
    """Publish partition identities and items while optional maintenance stays queued.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        batches = [
            items(identifier, str(index), index * 10, index * 10 + 9)
            for index in range(4)
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with statistics_barriers(catalog_database, names[:1]) as (control, _):
            initial = deadlocks(control)
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [
                    pool.submit(
                        ingest, catalog_database, names[0], batches[0], use_queue=True
                    )
                ]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.extend(
                        pool.submit(
                            ingest, catalog_database, name, batch, use_queue=True
                        )
                        for name, batch in zip(names[1:], batches[1:], strict=True)
                    )
                    wait_for_writers(control, names[1:], names[0])
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database,
                identifier,
                batches,
                results,
                initial,
                deferred_constraints=True,
            )
