/** Format-neutral Catalog preparation and mixed map-layer coordination. */

import { getCatalogVisualization } from "./catalog.js";
import { assessCatalogVector } from "./vector/api.js";

/** Coordinate dataset adapters without placing format checks in composition. */
export class CatalogVisualizationCoordinator {
    /**
     * Create the coordinator over the shared mixed-layer viewer.
     *
     * @param {Object} rasterViewer Raster-owned map and analysis boundary.
     * @param {Object} mapLayerController Neutral retained-layer controller.
     * @param {Object} vectorMapLayerAdapter Focused vector map-layer adapter.
     * @param {(item:Object)=>Promise<Object>} [assessVector=assessCatalogVector]
     * Vector assessment boundary.
     */
    constructor(
        rasterViewer,
        mapLayerController,
        vectorMapLayerAdapter,
        assessVector = assessCatalogVector
    ) {
        this.rasterViewer = rasterViewer;
        this.mapLayerController = mapLayerController;
        this.vectorMapLayerAdapter = vectorMapLayerAdapter;
        this.assessVector = assessVector;
    }

    /**
     * Return the supported kind and current preparation metadata for one Item.
     *
     * @param {Object|null} item Selected STAC Item.
     * @return {{kind:"raster"|"vector",metadata:Object|undefined}|null}
     * Visualization descriptor or null when unsupported.
     */
    describe(item) {
        return getCatalogVisualization(item);
    }

    /**
     * Prepare one Item through its explicitly owned adapter.
     *
     * Prepared rasters need no browser preflight. Vectors retain their
     * authoritative capability assessment before publication.
     *
     * @param {Object} item Selected supported STAC Item.
     * @return {Promise<Object>} Prepared Item; vectors carry fresh assessment.
     * @throws {TypeError} If the Item has no visualization adapter.
     */
    prepare(item) {
        const descriptor = this.#requireDescriptor(item);
        return descriptor.kind === "raster"
            ? Promise.resolve(item)
            : this.assessVector(item);
    }

    /**
     * Publish and retain one Item in the shared mixed layer lifecycle.
     *
     * @param {Object} item Selected supported and prepared STAC Item.
     * @return {Promise<Object|null>} Publication or null after invalidation.
     * @throws {TypeError} If the Item has no visualization adapter.
     */
    show(item) {
        const descriptor = this.#requireDescriptor(item);
        return descriptor.kind === "raster"
            ? this.rasterViewer.show(item)
            : this.mapLayerController.show(item, this.vectorMapLayerAdapter);
    }

    /**
     * Publish and construct one supported layer without attaching it to a map.
     *
     * @param {Object} item Supported and prepared Catalog Item.
     * @param {{visible:boolean,opacity:number}} presentation Initial neutral
     * layer visibility and opacity.
     * @return {Promise<{key:string,record:Object,layer:Object}>} Detached layer
     * prepared by the owning raster or vector adapter.
     * @throws {TypeError} If the Item has no visualization adapter.
     */
    stage(item, presentation) {
        const descriptor = this.#requireDescriptor(item);
        return descriptor.kind === "raster"
            ? this.rasterViewer.stage(item, presentation)
            : this.mapLayerController.stage(
                item,
                this.vectorMapLayerAdapter,
                presentation
            );
    }

    /**
     * Return whether one Item is retained in the mixed layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {boolean} Whether the Item is retained.
     */
    contains(item) {
        return this.mapLayerController.contains(item);
    }

    /**
     * Remove one retained Item from the mixed layer stack.
     *
     * @param {Object} item Retained Catalog STAC Item.
     * @return {void}
     */
    remove(item) {
        this.mapLayerController.remove(item);
    }

    /**
     * Clear Catalog layers and raster interactions, preserving local layers.
     *
     * @return {void}
     */
    clear() {
        this.rasterViewer.clear();
        this.mapLayerController.clear({ preserveLocal: true });
    }

    /**
     * Return a user-facing dataset noun for one supported Item.
     *
     * @param {Object} item Supported Catalog STAC Item.
     * @return {"raster"|"vector layer"} Dataset noun.
     */
    noun(item) {
        return this.#requireDescriptor(item).kind === "raster"
            ? "raster"
            : "vector layer";
    }

    /**
     * Return the scanner-owned source revision for compatibility checks.
     *
     * The revision is an opaque value. Consumers must not infer paths or
     * rendering authorization from its structure.
     *
     * @param {Object} item Supported, assessed Catalog Item.
     * @return {unknown|null} Opaque revision or null when not supplied.
     */
    sourceRevision(item) {
        const descriptor = this.#requireDescriptor(item);
        return descriptor.kind === "raster"
            ? item.assets?.data?.["eolab:source"]?.source_signature ?? null
            : descriptor.metadata?.source_signature ?? null;
    }

    /**
     * Require one supported visualization descriptor.
     *
     * @param {Object} item Candidate Catalog STAC Item.
     * @return {{kind:"raster"|"vector",metadata:Object|undefined}}
     * Supported descriptor.
     * @throws {TypeError} If no owned visualization adapter exists.
     */
    #requireDescriptor(item) {
        const descriptor = this.describe(item);
        if (descriptor === null) {
            throw new TypeError("Catalog Item has no map visualization adapter.");
        }
        return descriptor;
    }
}
