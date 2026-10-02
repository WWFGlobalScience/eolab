"""Compose the EOLab application, shared clients, and feature routers."""

from collections.abc import AsyncIterator
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from pathlib import Path
import logging
import signal

import httpx2
from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from eolab_app.annotation_sessions.store import AnnotationSessionStore
from eolab_app.saved_maps.store import SavedMapStore
from eolab_app.routes.saved_maps import (
    create_saved_maps_router,
    create_saved_maps_admin_router,
)
from eolab_app.routes.admin_auth import create_administrator_dependency
from eolab_app.saved_maps.models import Slug
from eolab_app.routes.annotation_sessions import create_annotation_sessions_router
from eolab_app.routes.shared_layer_admin import create_shared_layer_admin_router
from eolab_app.catalog.pgstac import PgStacCatalogDatabase
from eolab_app.catalog.finalization import CompositeDatasetItemFinalizer
from eolab_app.catalog.reconciliation import MissingItemReconciler
from eolab_app.catalog.scanner import ScanManager
from eolab_app.catalog.search_counts import number_matched_is_estimated
from eolab_app.catalog.stac_api import StacApiWriter
from eolab_app.diagnostics.service import RenderingDiagnosticsService
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.job_notifications import PostgresJobWakeup
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.job_events import PostgresJobEvents
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.worker import ProcessingWorker, serve as serve_processing
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.geoserver import GeoServerRasterPublisher
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.source_authorization import (
    CatalogRasterSourceAuthorizer,
)
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.routes.catalog import create_catalog_router
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.routes.diagnostics import create_diagnostics_router
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.rasters import create_raster_feature
from eolab_app.routes.processing import create_processing_router
from eolab_app.routes.processing_timings import ProcessingHttpTimings
from eolab_app.routes.scans import create_scan_router
from eolab_app.routes.jobs_proxy import create_jobs_proxy_router
from eolab_app.routes.stac_proxy import (
    NumberMatchedEstimateLookup,
    create_stac_proxy_router,
)
from eolab_app.routes.system import create_system_router
from eolab_app.routes.vectors import create_vector_feature
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.settings import (
    APPLICATION_VERSION_PATH,
    load_settings,
    load_processing_worker_settings,
    load_processing_limits,
)
from eolab_app.vector.assessment import (
    VectorAssessmentFinalizer,
    VectorAssessmentService,
)
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.fields import OgrVectorFieldReader
from eolab_app.vector.geoserver import (
    GeoServerVectorPublisher,
    GeoServerVectorReaderAssessor,
)
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
)
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.outline_jobs import OutlineJobs
from eolab_app.vector.selection_jobs import SelectionJobs
from eolab_jobs.client import JobsClient
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.styling import VectorStyleService


def create_app(
    version_file_path: Path = APPLICATION_VERSION_PATH,
    catalog_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_diagnostics_transport: httpx2.AsyncBaseTransport | None = None,
    number_matched_estimate_lookup: NumberMatchedEstimateLookup = (
        number_matched_is_estimated
    ),
    jobs_transport: httpx2.AsyncBaseTransport | None = None,
) -> FastAPI:
    """Create an application from the deployment environment.

    Args:
        version_file_path: File containing the Git-derived application version.
            The default allows Uvicorn to invoke this factory without arguments;
            tests pass a temporary version file.
        catalog_transport: HTTP transport used to reach the internal STAC API.
            The default creates a real network transport; tests pass a mock
            transport.
        geoserver_transport: HTTP transport used to reach internal GeoServer.
            The default creates a real network transport; tests pass a mock
            transport.
        geoserver_diagnostics_transport: HTTP transport used only for bounded
            internal metrics and WMS readiness probes. The default creates a
            real network transport; tests pass a mock transport.
        number_matched_estimate_lookup: Determines whether pgSTAC estimated an
            Item Search count. Tests pass a database-free implementation.
        jobs_transport: Independent Job service transport; tests may inject its
            ASGI app without starting a container or contacting other services.

    Returns:
        A FastAPI application configured from the validated deployment
        environment, with its health and public-configuration routes
        registered and its static frontend mounted.

    Raises:
        FileNotFoundError: If the baked version file does not exist.
        KeyError: If a required environment variable is missing.
        ValueError: If an environment value violates the settings contract.
    """
    app_global_configuration = load_settings(version_file_path)
    catalog_client = httpx2.AsyncClient(
        transport=catalog_transport,
        timeout=10,
    )
    geoserver_wms_client = httpx2.AsyncClient(
        transport=geoserver_transport,
        timeout=30,
    )
    geoserver_rest_client = httpx2.AsyncClient(
        transport=geoserver_transport,
        timeout=30,
        auth=httpx2.BasicAuth(
            app_global_configuration.geoserver_admin_user,
            app_global_configuration.geoserver_admin_password,
        ),
    )
    geoserver_diagnostics_client = httpx2.AsyncClient(
        transport=geoserver_diagnostics_transport,
        timeout=3,
    )
    jobs_client = httpx2.AsyncClient(
        transport=jobs_transport,
        timeout=10,
        trust_env=False,
        limits=httpx2.Limits(max_connections=10, max_keepalive_connections=5),
    )
    raster_catalog = StacRasterCatalog(
        catalog_client,
        app_global_configuration.catalog_internal_url,
    )
    raster_source_resolver = MountedRasterResolver(
        app_global_configuration.scan_mount_path
    )
    raster_source_authorizer = CatalogRasterSourceAuthorizer(
        raster_catalog,
        raster_source_resolver,
    )
    published_rasters = PublishedRasterRegistry()
    vector_catalog = StacVectorCatalog(
        catalog_client, app_global_configuration.catalog_internal_url
    )
    vector_source_resolver = MountedVectorResolver(
        app_global_configuration.scan_mount_path
    )
    vector_jobs = JobsClient(jobs_client, app_global_configuration.jobs_token)
    vector_selection_reader = VectorSamplingService(
        vector_catalog, vector_source_resolver,
        OutlineJobs(vector_jobs),
        selection_executor=SelectionJobs(vector_jobs),
    )
    raster_pixel_service = RasterPixelService(
        raster_source_authorizer,
        app_global_configuration.raster_pixel_read_concurrency,
    )
    raster_statistics_service = RasterStatisticsService(
        raster_source_authorizer,
        app_global_configuration.raster_statistics_read_concurrency,
        app_global_configuration.raster_statistics_cache_entries,
        catalog_selection_reader=vector_selection_reader,
        queue_capacity=app_global_configuration.raster_statistics_queue_capacity,
        queue_wait_seconds=app_global_configuration.raster_statistics_queue_wait_seconds,
        max_waiters=app_global_configuration.raster_statistics_max_waiters,
    )
    raster_feature = create_raster_feature(
        RasterPublicationService(
            raster_catalog,
            raster_source_resolver,
            GeoServerRasterPublisher(
                geoserver_rest_client,
                app_global_configuration.geoserver_internal_url,
            ),
            published_rasters,
        ),
        published_rasters,
    )
    vector_catalog = StacVectorCatalog(
        catalog_client,
        app_global_configuration.catalog_internal_url,
    )
    vector_source_resolver = MountedVectorResolver(
        app_global_configuration.scan_mount_path
    )
    vector_reader_assessor = GeoServerVectorReaderAssessor(
        geoserver_rest_client,
        app_global_configuration.geoserver_internal_url,
    )
    vector_assessment_finalizer = VectorAssessmentFinalizer(
        vector_source_resolver,
        vector_reader_assessor,
    )
    published_vectors = PublishedVectorRegistry()
    vector_publisher = GeoServerVectorPublisher(
        geoserver_rest_client,
        app_global_configuration.geoserver_internal_url,
    )
    vector_field_reader = OgrVectorFieldReader()
    vector_feature = create_vector_feature(
        VectorAssessmentService(
            app_global_configuration.scan_mount_path,
            vector_catalog,
            vector_source_resolver,
            vector_assessment_finalizer,
        ),
        VectorPublicationService(
            vector_catalog,
            vector_source_resolver,
            vector_publisher,
            published_vectors,
            field_reader=vector_field_reader,
        ),
        VectorStyleService(
            vector_catalog,
            vector_source_resolver,
            vector_publisher,
            published_vectors,
            vector_field_reader,
        ),
        published_vectors,
    )
    get_map_request_tracker = GetMapRequestTracker(
        app_global_configuration.geoserver_wms_render_count
    )
    render_queue = GeoServerRenderQueue(
        app_global_configuration.geoserver_wms_render_count,
        app_global_configuration.map_render_queue_capacity,
        app_global_configuration.map_render_queue_wait_seconds,
    )
    rendering_diagnostics = RenderingDiagnosticsService(
        geoserver_diagnostics_client,
        app_global_configuration.geoserver_metrics_internal_url,
        app_global_configuration.geoserver_internal_url,
        get_map_request_tracker,
    )
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        """Own and close all shared upstream connection pools.

        Args:
            _: FastAPI application supplied by the lifespan protocol.

        Yields:
            Control while the application serves requests.
        """
        async with AsyncExitStack() as client_stack:
            client_stack.push_async_callback(asyncio.to_thread, processing_store.close)
            processing_store.open()
            client_stack.push_async_callback(processing_events.close)
            processing_events.start()
            for client in (
                catalog_client,
                geoserver_wms_client,
                geoserver_rest_client,
                geoserver_diagnostics_client,
                jobs_client,
            ):
                client_stack.push_async_callback(client.aclose)
            client_stack.push_async_callback(render_queue.close)
            yield

    application = FastAPI(
        title=app_global_configuration.app_title,
        description=app_global_configuration.app_subtitle,
        version=app_global_configuration.app_version,
        lifespan=lifespan,
    )
    application.add_middleware(ProcessingHttpTimings)
    annotation_sessions = AnnotationSessionStore(
        layer_capacity=app_global_configuration.shared_layer_capacity,
        creation_limit=app_global_configuration.shared_layer_creation_limit,
        creation_window_seconds=app_global_configuration.shared_layer_creation_window_seconds,
    )
    application.include_router(create_annotation_sessions_router(annotation_sessions))
    application.include_router(
        create_shared_layer_admin_router(
            annotation_sessions, app_global_configuration.admin_password
        )
    )
    catalog_database = PgStacCatalogDatabase()
    saved_maps = SavedMapStore(capacity=app_global_configuration.saved_map_capacity)
    application.include_router(create_saved_maps_router(saved_maps))
    application.include_router(
        create_saved_maps_admin_router(saved_maps, app_global_configuration.admin_password)
    )
    application.include_router(
        create_catalog_router(catalog_database.random_matching_item)
    )
    application.include_router(
        create_raster_analysis_router(
            raster_pixel_service,
            raster_statistics_service,
        )
    )
    application.include_router(raster_feature.router)
    application.include_router(vector_feature.router)
    application.include_router(create_vector_sampling_router(vector_selection_reader))
    processing_limits = load_processing_limits()
    processing_events = PostgresJobEvents()
    processing_store = PostgresJobStore(processing_limits)
    processing_service = ProcessingService(
        processing_store,
        LocalJobArtifacts(
            app_global_configuration.processing_data_path,
            (Path.cwd(), app_global_configuration.scan_mount_path),
        ),
        changes=processing_events,
    )
    application.include_router(create_processing_router(processing_service))
    scan_manager = ScanManager(
        app_global_configuration.scan_mount_path,
        tuple(
            app_global_configuration.scan_mount_path / relative_path
            for relative_path in app_global_configuration.scan_paths_within_mount
        ),
        StacApiWriter(
            app_global_configuration.catalog_internal_url,
            catalog_transport,
            write_timeout_seconds=(
                app_global_configuration.scan_catalog_write_timeout_seconds
            ),
            error_detail_limit=(
                app_global_configuration.scan_catalog_error_detail_limit
            ),
        ),
        catalog_database,
        app_global_configuration.scan_worker_count,
        app_global_configuration.scan_writer_count,
        app_global_configuration.scan_batch_size,
        item_finalizer=CompositeDatasetItemFinalizer((
            vector_assessment_finalizer,
        )),
        reconciler=MissingItemReconciler(
            app_global_configuration.scan_mount_path,
            catalog_database,
            app_global_configuration.scan_batch_size,
            page_size=app_global_configuration.scan_reconciliation_page_size,
            concurrency=(
                app_global_configuration.scan_reconciliation_concurrency
            ),
            spool_memory_bytes=(
                app_global_configuration.scan_reconciliation_spool_memory_bytes
            ),
        ),
        error_detail_limit=app_global_configuration.scan_error_detail_limit,
    )
    application.include_router(create_scan_router(scan_manager))
    application.include_router(create_jobs_proxy_router(jobs_client))
    application.include_router(
        create_system_router(
            app_global_configuration.app_version,
            app_global_configuration.as_public_dict(),
        )
    )
    application.include_router(create_diagnostics_router(rendering_diagnostics))
    application.include_router(
        create_stac_proxy_router(
            catalog_client,
            app_global_configuration.catalog_internal_url,
            number_matched_estimate_lookup,
        )
    )
    application.include_router(
        create_wms_proxy_router(
            geoserver_wms_client,
            app_global_configuration.geoserver_internal_url,
            (raster_feature.registry, vector_feature.registry),
            get_map_request_tracker,
            render_queue,
        )
    )
    application.include_router(
        create_composite_map_router(
            CompositeMapRenderingService(
                (raster_feature.registry, vector_feature.registry)
            ),
            geoserver_wms_client,
            app_global_configuration.geoserver_internal_url,
            get_map_request_tracker,
            render_queue,
            app_global_configuration.composite_tile_cache_bytes,
        )
    )

    static_directory = Path(__file__).parent / "static"

    @application.get(
        "/admin-eolab/maps/{slug}/edit",
        include_in_schema=False,
        dependencies=[
            Depends(create_administrator_dependency(app_global_configuration.admin_password))
        ],
    )
    def edit_published_map(slug: Slug) -> FileResponse:
        """Open the full map editor after administrator authentication.

        Args:
            slug: Fixed URL name; the editor loads its configuration through the admin API.

        Returns:
            Existing application HTML without caching the authenticated entry page.
        """
        return FileResponse(
            static_directory / "index.html", headers={"Cache-Control": "private, no-store"}
        )

    @application.get("/maps/{slug:path}", include_in_schema=False)
    def open_named_map(slug: str) -> FileResponse:
        """Serve the existing viewer for a named-map URL, including direct reloads.

        Args:
            slug: URL name validated by the browser and saved-map API, never a file path.

        Returns:
            The application HTML. Missing or invalid map names are reported by its viewer.
        """
        return FileResponse(
            static_directory / "index.html", headers={"Cache-Control": "no-cache"}
        )

    application.mount(
        "/",
        StaticFiles(directory=static_directory, html=True, check_dir=False),
        name="frontend",
    )

    return application


async def run_processing_worker() -> None:
    """Start configured worker loops, each with its own native calculation process.

    No web application or GeoServer client is constructed.
    Migrate and interrupt unfinished jobs once before starting any loops. The
    container must replace the previous worker container, not overlap it.
    Completed results remain available. Child recycling never repeats the reset.

    Raises:
        ValueError: If source and artifact configuration is unsafe.
        asyncio.CancelledError: After orderly native-child shutdown.
    """
    settings = load_processing_worker_settings()
    limits = load_processing_limits()
    artifacts = LocalJobArtifacts(
        settings.processing_data_path, (Path.cwd(), settings.scan_mount_path)
    )
    artifacts.initialize()
    jobs = PostgresJobStore(limits)
    async with httpx2.AsyncClient(timeout=10) as client, AsyncExitStack() as lifecycle:
        lifecycle.push_async_callback(asyncio.to_thread, jobs.close)
        jobs.open()
        authorizer = CatalogRasterSourceAuthorizer(
            StacRasterCatalog(client, settings.catalog_internal_url),
            MountedRasterResolver(settings.scan_mount_path),
        )
        areas = VectorSamplingService(
            StacVectorCatalog(client, settings.catalog_internal_url),
            MountedVectorResolver(settings.scan_mount_path),
        )
        task = asyncio.current_task()
        for event in (signal.SIGTERM, signal.SIGINT):
            with suppress(NotImplementedError):
                asyncio.get_running_loop().add_signal_handler(event, task.cancel)
        while True:
            try:
                await asyncio.to_thread(jobs.migrate)
                await asyncio.to_thread(jobs.interrupt_unfinished_jobs_on_restart)
                break
            except ProcessingError:
                logging.getLogger(__name__).warning(
                    "Processing startup is unavailable; retrying in five seconds"
                )
                await asyncio.sleep(5)
        cleanup_lock = asyncio.Lock()
        async with asyncio.TaskGroup() as workers:
            for _ in range(
                min(
                    limits.worker_count,
                    limits.max_execution_memory_bytes // limits.process_memory_bytes,
                )
            ):
                execution_native = create_native_process(limits)
                lifecycle.push_async_callback(execution_native.close)
                execution_native.warm()
                worker = ProcessingWorker(
                    authorizer,
                    jobs,
                    artifacts,
                    limits,
                    native=execution_native,
                    areas=areas,
                )
                workers.create_task(
                    serve_processing(worker, PostgresJobWakeup(), cleanup_lock)
                )
