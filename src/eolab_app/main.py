"""Compose the EOLab application, shared clients, and feature routers."""

from collections.abc import AsyncIterator
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from pathlib import Path
import logging
import signal

import httpx2
from fastapi import Depends, FastAPI, HTTPException, Request, Response
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
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.routes.shared_layer_admin import create_shared_layer_admin_router
from eolab_app.catalog.pgstac import PgStacCatalogDatabase
from eolab_app.catalog.finalization import CompositeDatasetItemFinalizer
from eolab_app.catalog.reconciliation import MissingItemReconciler
from eolab_app.catalog.scanner import ScanManager
from eolab_app.catalog.search_counts import number_matched_is_estimated
from eolab_app.catalog.stac_api import StacApiWriter
from eolab_app.diagnostics.service import RenderingDiagnosticsService
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.polygon_areas import (
    PolygonAreaReference,
    PolygonSummaryInput,
    read_polygon_area_input,
)
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
from eolab_app.raster.errors import (
    RasterConflictError,
    RasterFeatureError,
    RasterUpstreamError,
)
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.publication import (
    RasterPublicationService,
    is_temporal_raster_layer,
    temporary_raster_source,
)
from eolab_app.raster.source_authorization import (
    CatalogRasterSourceAuthorizer,
)
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.artifact_preview import ArtifactPreviewService
from eolab_app.rendering.errors import PublishedLayerChangedError
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.routes.catalog import create_catalog_router
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.routes.diagnostics import create_diagnostics_router
from eolab_app.routes.habitat import create_habitat_router
from eolab_app.routes.habitat_preparation import create_habitat_preparation_router
from eolab_app.processing.habitat_preparation_models import (
    OPERATION as HABITAT_INPUT_PREPARATION_OPERATION,
)
from eolab_app.routes.habitat_admin import create_habitat_admin_router
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.routes.rasters import create_raster_feature
from eolab_app.routes.processing import (
    create_processing_router,
    get_processing_session_owner_hash,
)
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.source_files import SourceFileError
from eolab_app.processing.source_access import create_model_source_files
from eolab_app.routes.scans import create_scan_router
from eolab_app.routes.jobs_proxy import create_jobs_proxy_router
from eolab_app.routes.stac_proxy import (
    NumberMatchedEstimateLookup,
    create_stac_proxy_router,
)
from eolab_app.routes.system import create_system_router
from eolab_app.routes.vectors import (
    create_uploaded_vector_router,
    create_vector_feature,
)
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
from eolab_app.vector.extent_jobs import ExtentJobs
from eolab_jobs.client import JobsClient
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.styling import VectorStyleService
from eolab_app.vector.uploaded_sources import UploadedVectorSourceResolver
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore


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
    vector_uploads = VectorUploadStore(
        app_global_configuration.vector_upload_data_path,
        app_global_configuration.vector_upload_max_bytes,
    )
    vector_selection_reader = VectorSamplingService(
        vector_catalog,
        vector_source_resolver,
        OutlineJobs(vector_jobs),
        selection_executor=SelectionJobs(vector_jobs),
        extent_executor=ExtentJobs(vector_jobs),
        uploads=vector_uploads,
    )
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
        model_authorizer=raster_source_authorizer,
        uploads=vector_uploads,
        areas=vector_selection_reader,
    )
    source_files = create_model_source_files(processing_service)
    raster_sources = RasterSourceAccess(raster_source_authorizer, source_files)
    processing_session_ttl = max(
        7 * 86_400,
        processing_limits.result_ttl_seconds,
        processing_limits.metadata_ttl_seconds,
    )
    raster_pixel_service = RasterPixelService(
        raster_sources,
        app_global_configuration.raster_pixel_read_concurrency,
    )

    async def read_histogram_polygon_area(
        owner: str, reference: PolygonAreaReference
    ) -> PolygonSummaryInput:
        """Load histogram polygons using the existing temporary input store.

        Args:
            owner: Server-derived session hash for the browser making the request.
            reference: Expiring identifier and geometry hash supplied by that browser.

        Returns:
            Authorized, validated WGS84 polygons for a bounded read.

        Raises:
            RasterConflictError: If the polygon selection is unavailable or expired.
            RasterUpstreamError: If temporary input storage is unavailable.
        """
        try:
            return await read_polygon_area_input(
                processing_store.get_input, owner, reference
            )
        except ProcessingError as error:
            if error.code == "input_unavailable":
                raise RasterConflictError(
                    "This drawn polygon area expired or is unavailable. Choose the polygon layer again."
                ) from error
            raise RasterUpstreamError(
                "Drawn polygon areas are temporarily unavailable. Try again shortly."
            ) from error
        except ValueError as error:
            raise RasterConflictError(
                "This drawn polygon area could not be read. Choose the polygon layer again."
            ) from error

    raster_statistics_service = RasterStatisticsService(
        raster_sources,
        app_global_configuration.raster_statistics_read_concurrency,
        app_global_configuration.raster_statistics_cache_entries,
        catalog_selection_reader=vector_selection_reader,
        polygon_area_reader=read_histogram_polygon_area,
        queue_capacity=app_global_configuration.raster_statistics_queue_capacity,
        queue_wait_seconds=app_global_configuration.raster_statistics_queue_wait_seconds,
        max_waiters=app_global_configuration.raster_statistics_max_waiters,
    )
    raster_publication = RasterPublicationService(
        raster_catalog,
        raster_source_resolver,
        GeoServerRasterPublisher(
            geoserver_rest_client,
            app_global_configuration.geoserver_internal_url,
        ),
        published_rasters,
        source_access=raster_sources,
        source_available=processing_service.model_artifact_is_available,
    )
    raster_feature = create_raster_feature(
        raster_publication,
        published_rasters,
        lambda request, response: get_processing_session_owner_hash(
            request, response, processing_session_ttl
        ),
    )

    async def authorize_map_layers(
        layer_names: tuple[str, ...], request: Request
    ) -> bool:
        """Check browser ownership before rendering private uploads or model outputs.

        Args:
            layer_names: Validated layer identities requested for WMS or composition.
            request: Browser request carrying its existing HttpOnly ownership cookies.

        Returns:
            Whether the response contains any private source.

        Raises:
            HTTPException: If ownership, expiry or file availability rejects access.
        """
        try:
            upload_ids = {
                identifier
                for name in layer_names
                if (identifier := published_vectors.get_upload_id(name)) is not None
            }
            private = bool(upload_ids)
            if upload_ids:
                owner = get_browser_owner_hash(
                    request, Response(), mutation_header="X-EOLab-Uploads"
                )
                for identifier in upload_ids:
                    await asyncio.to_thread(
                        vector_uploads.get_upload_source, owner, identifier
                    )
            if any(temporary_raster_source(name) for name in layer_names):
                owner = get_processing_session_owner_hash(
                    request, Response(), processing_session_ttl
                )
                private = (
                    await raster_publication.authorize_layers(layer_names, owner)
                    or private
                )
            return private
        except (SourceFileError, VectorUploadError) as error:
            raise HTTPException(
                error.status, str(error), headers={"Cache-Control": "private, no-store"}
            ) from error
        except PublishedLayerChangedError as error:
            raise HTTPException(
                409, str(error), headers={"Cache-Control": "private, no-store"}
            ) from error
        except HTTPException as error:
            error.headers = {
                **(error.headers or {}),
                "Cache-Control": "private, no-store",
            }
            raise

    @asynccontextmanager
    async def use_map_layers(layer_names: tuple[str, ...]) -> AsyncIterator[None]:
        """Keep temporal layers published until the upstream request finishes.

        Args:
            layer_names: Authorized layer identities requested by a rendering route.

        Yields:
            None while the route may read the layers through GeoServer.

        Raises:
            HTTPException: If an explicit refresh revoked a queued temporal layer.
        """
        try:
            async with raster_publication.use_layers(layer_names):
                yield
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error

    async def reconcile_output_publications() -> None:
        """Retry obsolete model-result and temporal display cleanup.

        Runs every thirty seconds while the API is alive. Private WMS access
        checks expiry on every request, including when cleanup is unavailable.

        Raises:
            asyncio.CancelledError: On application shutdown.
        """
        while True:
            await asyncio.sleep(30)
            try:
                await raster_publication.cleanup()
            except Exception:
                logging.getLogger(__name__).warning(
                    "Temporary raster publication cleanup will retry."
                )

    async def release_finished_upload_inputs() -> None:
        """Remove retained uploads after their Processing jobs have stopped.

        Reconciles every five seconds, including unfinished cleanup after a
        restart. Admission shares the service's lock; database outages keep files.

        Raises:
            asyncio.CancelledError: After in-flight cleanup stops on shutdown.
        """
        while True:
            await asyncio.sleep(5)
            try:
                await processing_service.reconcile_upload_inputs()
            except (ProcessingError, VectorUploadError):
                logging.getLogger(__name__).warning(
                    "Retained upload cleanup will retry."
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
    vector_publication = VectorPublicationService(
        vector_catalog,
        vector_source_resolver,
        vector_publisher,
        published_vectors,
        field_reader=vector_field_reader,
    )
    vector_styles = VectorStyleService(
        vector_catalog,
        vector_source_resolver,
        vector_publisher,
        published_vectors,
        vector_field_reader,
    )
    vector_feature = create_vector_feature(
        VectorAssessmentService(
            app_global_configuration.scan_mount_path,
            vector_catalog,
            vector_source_resolver,
            vector_assessment_finalizer,
        ),
        vector_publication,
        vector_styles,
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
            publication_cleanup = asyncio.create_task(reconcile_output_publications())
            upload_cleanup = asyncio.create_task(release_finished_upload_inputs())
            try:
                yield
            finally:
                publication_cleanup.cancel()
                with suppress(asyncio.CancelledError):
                    await publication_cleanup
                upload_cleanup.cancel()
                with suppress(asyncio.CancelledError):
                    await upload_cleanup

    application = FastAPI(
        title=app_global_configuration.app_title,
        description=app_global_configuration.app_subtitle,
        version=app_global_configuration.app_version,
        lifespan=lifespan,
    )
    annotation_sessions = AnnotationSessionStore(
        layer_capacity=app_global_configuration.shared_layer_capacity,
        creation_limit=app_global_configuration.shared_layer_creation_limit,
        creation_window_seconds=app_global_configuration.shared_layer_creation_window_seconds,
    )
    application.include_router(create_annotation_sessions_router(annotation_sessions))
    application.include_router(create_vector_uploads_router(vector_uploads))
    application.include_router(
        create_uploaded_vector_router(
            UploadedVectorSourceResolver(vector_uploads),
            vector_publication,
            vector_styles,
        )
    )
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
        create_catalog_router(
            catalog_database.random_matching_item,
            raster_source_authorizer.get_time_choices,
            catalog_database.get_vector_field_values,
        )
    )
    application.include_router(
        create_raster_analysis_router(
            raster_pixel_service,
            raster_statistics_service,
            source_access=raster_sources,
            session_owner=lambda request, response: get_processing_session_owner_hash(
                request, response, processing_session_ttl
            ),
        )
    )
    application.include_router(raster_feature.router)
    application.include_router(vector_feature.router)
    application.include_router(create_vector_sampling_router(vector_selection_reader))
    application.include_router(create_habitat_router())
    application.include_router(
        create_habitat_preparation_router(
            processing_service, app_global_configuration.admin_password
        )
    )
    application.include_router(
        create_habitat_admin_router(
            vector_selection_reader,
            app_global_configuration.processing_data_path / "habitat-cache",
            app_global_configuration.admin_password,
        )
    )
    application.include_router(
        create_processing_router(
            processing_service,
            preview_artifact=ArtifactPreviewService(source_files).read,
            session_ttl_seconds=processing_session_ttl,
        )
    )

    async def refresh_temporal_items(item_keys: tuple[tuple[str, str], ...]) -> None:
        """Invalidate analysis caches and temporal layers after explicit Catalog writes.

        Args:
            item_keys: Collection and Item IDs written or retired by the scan.
        """
        await raster_statistics_service.invalidate_temporal_items(item_keys)
        await raster_publication.invalidate_temporal_items(item_keys)

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
        items_updated=refresh_temporal_items,
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
            authorize_layers=authorize_map_layers,
            use_layers=use_map_layers,
            hidden_layer=lambda name: (
                temporary_raster_source(name) is not None
                or is_temporal_raster_layer(name)
                or published_vectors.get_upload_id(name) is not None
            ),
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
            authorize_layers=authorize_map_layers,
            use_layers=use_map_layers,
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
        uploads = VectorUploadStore(settings.vector_upload_data_path, max_bytes=None)
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
            for _ in range(limits.worker_count):
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
                    uploads=uploads,
                    operation_settings={
                        "habitat.condition.v1": settings.habitat_earth_engine,
                        HABITAT_INPUT_PREPARATION_OPERATION: settings.habitat_earth_engine,
                    },
                )
                workers.create_task(
                    serve_processing(worker, PostgresJobWakeup(), cleanup_lock)
                )
