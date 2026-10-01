"""Exercise connection reuse and transaction isolation against real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from threading import Barrier
import psycopg
import pytest

from eolab_app.processing.job_store import PostgresJobStore, PROCESSING_ADVISORY_LOCK_ID
from eolab_app.processing.models import ProcessingError
from test_processing_jobs import store


def test_reuses_connections_and_rolls_back_before_return(
    store: PostgresJobStore,
) -> None:
    """Reuse bounded physical connections without retaining failed writes or locks.

    Args:
        store: Migrated disposable PostgreSQL adapter.
    """
    pids = set()
    for _ in range(25):
        with store._transaction() as cursor:
            cursor.execute(
                "SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock"
            )
            row = cursor.fetchone()
            pids.add(row["pid"])
            assert row["statement"] == "5s" and row["lock"] == "3s"
    assert len(pids) <= 8
    with pytest.raises(RuntimeError, match="rollback"):
        with store._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "INSERT INTO processing.calculation_results(cache_key,payload,expires_at) VALUES (%s,'{}',now()+interval '1 hour')",
                ("a" * 64,),
            )
            raise RuntimeError("rollback")
    with store._transaction() as cursor:
        cursor.execute("SELECT count(*) AS count FROM processing.calculation_results")
        assert cursor.fetchone()["count"] == 0
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT pg_try_advisory_xact_lock(%s)", (PROCESSING_ADVISORY_LOCK_ID,)
        ).fetchone()[0]


def test_concurrent_transactions_borrow_distinct_connections(
    store: PostgresJobStore,
) -> None:
    """Concurrent callers never share one transaction or exceed eight connections.

    Args:
        store: Migrated disposable PostgreSQL adapter.
    """
    barrier = Barrier(8)

    def borrow(_: int) -> int:
        """Hold a transaction until all eight callers have their own connection.

        Args:
            _: Caller index, unused.

        Returns:
            PostgreSQL process ID for this exclusively borrowed connection.
        """
        with store._transaction() as cursor:
            cursor.execute("SELECT pg_backend_pid() AS pid")
            pid = cursor.fetchone()["pid"]
            barrier.wait(timeout=5)
            return pid

    with ThreadPoolExecutor(max_workers=8) as callers:
        assert len(set(callers.map(borrow, range(8)))) == 8
    assert store._pool.get_stats()["pool_size"] == 8


def test_replaces_terminated_connections_before_use(store: PostgresJobStore) -> None:
    """An idle connection killed by PostgreSQL is replaced on the next checkout.

    Args:
        store: Migrated disposable PostgreSQL adapter.
    """
    with ExitStack() as borrowed:
        connections = [
            borrowed.enter_context(store._pool.connection()) for _ in range(8)
        ]
        pids = [connection.info.backend_pid for connection in connections]
    terminated_pid = pids[0]
    with psycopg.connect(store.conninfo, autocommit=True) as administrator:
        assert administrator.execute(
            "SELECT pg_terminate_backend(%s)", (terminated_pid,)
        ).fetchone()[0]
    with ExitStack() as borrowed:
        replacement_pids = set()
        for _ in range(8):
            cursor = borrowed.enter_context(store._transaction())
            cursor.execute("SELECT pg_backend_pid() AS pid")
            pid = cursor.fetchone()["pid"]
            assert pid != terminated_pid
            replacement_pids.add(pid)
        assert len(replacement_pids) == 8
        assert replacement_pids - set(pids)


def test_pool_exhaustion_and_shutdown_use_storage_error(
    store: PostgresJobStore,
) -> None:
    """Saturation is bounded and closed pools do not silently reopen.

    Args:
        store: Migrated disposable PostgreSQL adapter.
    """
    with ExitStack() as borrowed:
        connections = [
            borrowed.enter_context(store._pool.connection()) for _ in range(8)
        ]
        with pytest.raises(ProcessingError) as error:
            store.find_request("owner", "request")
        assert error.value.code == "processing_unavailable"
        assert not any(connection.closed for connection in connections)
    store.close()
    assert all(connection.closed for connection in connections)
    store.close()
    with pytest.raises(ProcessingError) as error:
        store.find_request("owner", "request")
    assert error.value.code == "processing_unavailable"
