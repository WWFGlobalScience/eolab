/** Build model drafts from available source identities and explicit analysis areas. */
import { normalizeCalculationArea } from "../processing/calculation-area.js";
import { createTemporalDraft, captureTemporalInput, captureTemporalReduction } from "./temporal-inputs.js";

/** @typedef {{key:string,label:string,polygons:Array<{type:"Polygon",coordinates:number[][][]}>,total:number}} DrawnPolygonLayer */

/** Check whether a model declares an input of the requested type.
 * @param {Object} model Installed recipe.
 * @param {string} type Input type from the model contract.
 * @return {boolean} Whether the recipe needs this control.
 */
export function modelHasInput(model, type) { return Object.values(model.inputs).some(input => input.type === type); }

/** Find the active Earth Engine stack in this model's editable inputs.
 * @param {Object} draft Model draft with named input state.
 * @return {Object|undefined} Habitat stack state, absent when manual rasters are selected.
 */
export function getHabitatEarthEngineInput(draft) {
    const name = Object.keys(draft.model.inputs).find(key => draft.model.inputs[key].type === "habitat_stack");
    const input = draft.inputs[name];
    return input?.kind === "earthEngine" ? input : undefined;
}

/** Identify a raster or vector choice without using its label or map visibility.
 * @param {Object} source Catalog identity, uploaded vector identity or owned run-file reference.
 * @return {string} Composite identity for a choice list.
 */
export function modelSourceKey(source) {
    return JSON.stringify(source.kind === "runArtifact" ? [source.kind, source.jobId, source.artifactId]
        : source.uploadId ? ["upload", source.uploadId] : [source.collectionId, source.itemId]);
}

/** List unexpired raster outputs available as inputs to another model run.
 * @param {Object[]} runs Run status and file lists already loaded by Models.
 * @return {Object[]} Source choices; display previews and transient files are excluded.
 */
export function modelResultSources(runs) {
    return runs.filter(run => run.status === "ready" && Date.parse(run.expiresAt) > Date.now() && run.artifacts?.availability === "available")
        .flatMap(run => run.artifacts.files.filter(file => file.mediaType === "image/tiff" && ["result", "intermediate"].includes(file.role))
            .map(file => ({kind: "runArtifact", jobId: run.jobId, artifactId: file.artifactId, label: file.displayName ?? `${file.label} · ${run.label}`, available: true, expiresAt: run.expiresAt})));
}

/** List the editable raster values used by a draft's declared inputs.
 * Refresh and run observation use these locations to follow every selected file,
 * including stack rows and reference rasters. Inactive reference-raster choices
 * are left alone until the user switches that input back to raster mode.
 * @param {Object} draft Model setup with named input state.
 * @return {Array<{state:Object,field:"raster"|"maskRaster",optional:boolean}>} Mutable source
 * locations. Optional choices retain a missing source so it cannot become an
 * omitted mask without the user clearing it.
 */
export function getModelRasterFields(draft) {
    const fields = [];
    for (const [name, definition] of Object.entries(draft.model.inputs)) {
        const state = draft.inputs[name];
        if (["raster", "catalog_raster", "optional_raster"].includes(definition.type)) {
            fields.push({state, field: "raster", optional: definition.type === "optional_raster"});
        } else if (["mask_source", "habitat_references"].includes(definition.type) && state.areaMode === "raster") {
            fields.push({state, field: "maskRaster", optional: false});
        } else if (definition.type === "habitat_stack" && state.kind === "manual") {
            for (const row of [...state.predictors, ...state.responses]) fields.push({state: row, field: "raster", optional: false});
        }
    }
    return fields;
}

/** List active raster roles and their independent preparation choices.
 * @param {Object} draft Model draft with named stack, reference and mask inputs.
 * @return {Array<{key:string,state:Object,raster:Object,label:string}>} Selected inputs keyed by the operation's raster roles.
 */
export function getRasterPreparationSources(draft) {
    const sources = [];
    const preparationName = Object.keys(draft.model.inputs).find(name => draft.model.inputs[name].type === "raster_preparation");
    if (!preparationName) return sources;
    const step = draft.model.steps.find(value => value.inputs.preparation?.input === preparationName);
    for (const [argument, binding] of Object.entries(step.inputs)) {
        if (!binding.input) continue;
        const definition = draft.model.inputs[binding.input], state = draft.inputs[binding.input];
        if (definition.type === "habitat_stack" && state.kind === "manual") {
            for (const [role, prefix] of [["predictors", "predictor"], ["responses", "response"]]) {
                state[role].forEach((row, index) => {
                    if (row.raster) sources.push({key: `${prefix}_${index}`, state: row, raster: row.raster, label: row.name});
                });
            }
        } else if (definition.type === "habitat_references" && state.areaMode === "raster" && state.maskRaster) {
            sources.push({key: "reference_mask", state, raster: state.maskRaster, label: definition.label});
        } else if (["raster", "catalog_raster", "optional_raster"].includes(definition.type) && state.raster) {
            sources.push({key: argument, state, raster: state.raster, label: definition.label});
        }
    }
    return sources;
}

/** Capture the chosen grid and each active raster's resampling method.
 * Metadata lookup failures do not prevent a user from choosing a custom grid.
 * @param {Object} value Editable grid choices.
 * @param {Object} draft Model draft supplying active raster roles.
 * @return {{crs:string,pixelSize:number[],origin:number[],resampling:Object}} Explicit preparation request.
 * @throws {Error} If the projection or positive X/Y pixel sizes are missing.
 */
export function captureRasterPreparation(value, draft) {
    if (!value.crs.trim()) throw new Error("Choose an output projection.");
    if (!value.pixelSize.every(size => Number.isFinite(size) && size > 0)) throw new Error("Choose a pixel size or enter positive pixel width and height.");
    return {crs: value.crs, pixelSize: [...value.pixelSize], origin: [...value.origin],
        resampling: Object.fromEntries(getRasterPreparationSources(draft).map(source => [source.key, source.state.resampling]))};
}

/** Capture an available raster choice using the ordinary path-free source contract.
 * @param {Object|null} raster Selected map raster or owned run result.
 * @param {Object[]} sources Current source choices in this model setup.
 * @param {string} [type="raster"] Input type; catalog_raster and mask_source exclude run results.
 * @return {Object} Catalog identity or owned run-artifact reference.
 * @throws {Error} If the source is absent, expired or ineligible for this input.
 */
function captureModelRaster(raster, sources, type = "raster") {
    const startingMask = type === "mask_source";
    if (!raster || !sources.some(source => modelSourceKey(source) === modelSourceKey(raster)))
        throw new Error(startingMask ? "Choose a starting raster from Map layers." : "Choose a raster from Map layers or a completed run.");
    if ((type === "catalog_raster" || startingMask) && raster.kind === "runArtifact")
        throw new Error(startingMask ? "Choose a starting raster from Map layers." : "This recipe requires a raster from Map layers.");
    if (raster.available === false || raster.kind === "runArtifact" && Date.parse(raster.expiresAt) <= Date.now())
        throw new Error("This raster is no longer available. Choose another input.");
    return raster.kind === "runArtifact" ?
        {kind: "runArtifact", jobId: raster.jobId, artifactId: raster.artifactId} : {collectionId: raster.collectionId, itemId: raster.itemId};
}

/** Capture either Earth Engine inputs for a year or explicitly selected Habitat rasters.
 * @param {Object} state Editable mode, year, server-provided options and manual stack rows.
 * @param {Object[]} sources Current source choices in this model setup.
 * @return {Object} Earth Engine year or named predictors/responses with ordinary raster references.
 * @throws {Error} If year choices have not loaded, or the year, roles, names or raster selections are invalid.
 */
export function captureHabitatStack(state, sources) {
    if (state.kind === "earthEngine") {
        if (!state.configuration) throw new Error("Wait for the Earth Engine year choices to load, or retry.");
        if (!Number.isInteger(state.year) || state.year < state.configuration.minimumYear || state.year > state.configuration.maximumYear)
            throw new Error("Choose an assessment year from the available years.");
        return {kind: "earthEngine", year: state.year};
    }
    if (!state.predictors.length || !state.responses.length) throw new Error("Choose at least one predictor and one observed response.");
    const names = [...state.predictors, ...state.responses].map(row => row.name.trim());
    if (names.some(name => !name)) throw new Error("Name each predictor and observed response.");
    if (new Set(names).size !== names.length) throw new Error("Give each predictor and observed response a different name.");
    const categoricalPredictor = state.categoricalPredictor.trim();
    if (!state.predictors.some(row => row.name.trim() === categoricalPredictor)) throw new Error("Choose the categorical predictor.");
    return {predictors: state.predictors.map(row => ({name: row.name.trim(), source: captureModelRaster(row.raster, sources)})),
        responses: state.responses.map(row => ({name: row.name.trim(), source: captureModelRaster(row.raster, sources)})), categoricalPredictor};
}

/** Explain the saved polygon selection without exposing server paths.
 * @param {Object} filter Typed catalog filter.
 * @return {string} Readable predicate, including its all/any rule.
 */
export function describeModelFilter(filter) {
    if (!filter?.enabled || !filter.rules.length) return "All features (no filter)";
    const operators = {eq: "equals", ne: "does not equal", gt: ">", ge: "≥", lt: "<", le: "≤", contains: "contains", missing: "is missing", present: "is present"};
    return filter.rules.map(rule => `${rule.field} ${operators[rule.operator] ?? rule.operator}${["missing", "present"].includes(rule.operator) ? "" : ` ${JSON.stringify(rule.value)}`}`)
        .join(filter.match === "any" ? " OR " : " AND ");
}

/** Translate a browser calculation area to the model submission schema.
 * @param {Object} area Explicit browser area descriptor.
 * @return {Object} Model area with catalog selections and upload references preserved.
 * @throws {Error} If the area is invalid.
 */
export function modelAreaInput(area) {
    const value = normalizeCalculationArea(area);
    if (value.kind === "catalogSelection") return {kind: value.kind, selection: value.catalogSelection};
    if (value.kind === "polygonArea") return {kind: value.kind, reference: value.polygonArea};
    return structuredClone(value);
}

/** Capture the visible part of the map within the canonical geographic world.
 * Blank margins outside the single map world are excluded from the rectangle.
 * @param {{west:number,south:number,east:number,north:number}|null} bounds Visible WGS 84 map bounds.
 * @return {Object} Independent, validated model area.
 * @throws {Error} If the viewport has no valid geographic rectangle.
 */
export function modelViewportArea(bounds) {
    if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
        throw new Error("The visible map extent is unavailable. Move the map or choose a vector layer.");
    }
    if (bounds.west === bounds.east || bounds.south === bounds.north) {
        throw new Error("The map has no visible area. Make room for the map, or choose a vector layer.");
    }
    const selectedBounds = {west: Math.max(-180, bounds.west), south: Math.max(-90, bounds.south),
        east: Math.min(180, bounds.east), north: Math.min(90, bounds.north)};
    if (selectedBounds.west >= selectedBounds.east || selectedBounds.south >= selectedBounds.north) {
        throw new Error("Move the map inside the world bounds, or choose another analysis area.");
    }
    return modelAreaInput({kind: "selectedArea", selectedBounds});
}

/** Check whether an area is accepted by one declared input type.
 * @param {string} type Recipe area, starting-mask or reference-sites input type.
 * @param {{kind:string}|null} area Explicit area descriptor.
 * @return {boolean} Whether this field accepts the area kind.
 */
export function modelSupportsArea(type, area) {
    const supportedAreaKinds = type === "clip_area" ? ["selectedArea", "samplingBox", "catalogSelection"] :
        type === "summary_area" ? ["selectedArea", "samplingBox", "catalogSelection", "wholeRaster", "polygonArea"] :
            type === "habitat_references" ? ["catalogSelection", "polygonArea"] : type === "mask_source" ? ["catalogSelection"] : [];
    return supportedAreaKinds.includes(area?.kind);
}

/** Find this field's drawn layer in the latest committed map snapshot.
 * @param {{drawnPolygonLayers:DrawnPolygonLayer[]}} draft Available drawn layers and their applied filters' polygons.
 * @param {{drawnPolygonKey:string}} input This field's independent layer choice.
 * @return {DrawnPolygonLayer|undefined} Filtered layer, or undefined when it is absent.
 */
export function selectedDrawnPolygonLayer(draft, input) {
    return draft.drawnPolygonLayers.find(layer => layer.key === input.drawnPolygonKey);
}

/** Create independent setup state for each declared raster and spatial input.
 * The selectedArea input is the sampling area used by raster histograms.
 * Models with a starting mask require the user to choose that mask explicitly.
 * Habitat starts with Earth Engine inputs and an explicit analysis area.
 * @param {Object} model Installed recipe.
 * @param {Object & {drawnPolygonLayers?:DrawnPolygonLayer[]}} context Catalog and map choices supplied by browser composition, with detached drawn layers for Ecosystem Condition.
 * @param {string} id Local draft identity.
 * @return {Object} Draft with field state in inputs[name], shared source choices,
 * temporal controls and parameters. Spatial fields select live vector views or
 * retain an explicitly captured area from the map or an earlier run.
 * @throws {Error} If the supplied map selection is invalid.
 */
export function createModelDraft(model, context, id) {
    const sources = structuredClone(context.rasters ?? []);
    const catalogRasters = sources.filter(source => source.kind !== "runArtifact");
    const visibleCatalogRasters = catalogRasters.filter(source => source.visible);
    const suggestedRaster = visibleCatalogRasters.length === 1 ? visibleCatalogRasters[0] : catalogRasters.length === 1 ? catalogRasters[0] : null;
    const usesStartingMask = modelHasInput(model, "mask_source");
    const usesTemporal = modelHasInput(model, "temporal_interval");
    const preparation = modelHasInput(model, "raster_preparation") ? {resampling: "nearest"} : {};
    const statisticType = Object.values(model.inputs).find(input => ["temporal_reduction", "area_statistic"].includes(input.type))?.type;
    const inputs = {};
    for (const [name, input] of Object.entries(model.inputs)) {
        if (["raster", "catalog_raster", "optional_raster"].includes(input.type)) {
            inputs[name] = {
                ...preparation,
                raster: input.type !== "optional_raster" && !usesStartingMask && suggestedRaster ? structuredClone(suggestedRaster) : null,
                sourceReason: input.type !== "catalog_raster" ? "Choose a raster from Map layers or a completed run. Results do not need to be shown on the map." : catalogRasters.length ? "Choose a raster from Map layers." : "Add a raster to Map layers to use this tool.",
            };
        } else if (input.type === "habitat_stack") {
            inputs[name] = {kind: "earthEngine", year: null, configuration: null, loading: false, error: "",
                predictors: [{name: "predictor_1", raster: null, ...preparation}], responses: [{name: "response_1", raster: null, ...preparation}], categoricalPredictor: ""};
        } else if (input.type === "raster_preparation") {
            const step = model.steps.find(value => value.inputs.preparation?.input === name);
            const settings = step.inputs.settings.value;
            inputs[name] = {requiredCrs: settings.required_crs, crs: settings.required_crs ?? "", pixelSize: [null, null], origin: [0, 0],
                mode: "auto", sourceKey: "", unit: "", choices: [], loading: false, error: ""};
        } else if (["summary_area", "clip_area", "mask_source", "habitat_references"].includes(input.type)) {
            const explicitSelection = ["mask_source", "habitat_references"].includes(input.type);
            let area = explicitSelection ? null : context.area ? modelAreaInput(context.area) : {kind: "wholeRaster"};
            let areaMode = explicitSelection ? "vector" : ({wholeRaster: "whole", selectedArea: "samplingArea", samplingBox: "samplingArea", polygonArea: "mapPolygons"})[area.kind] ?? "captured";
            let selectionError = "";
            if (!explicitSelection && (!modelSupportsArea(input.type, area) || usesTemporal && !context.area ||
                modelHasInput(model, "habitat_stack") && area.kind === "wholeRaster")) {
                areaMode = "viewport"; area = null;
                try { area = modelViewportArea(context.viewportBounds); }
                catch (error) { selectionError = error.message; }
            }
            inputs[name] = {
                ...(explicitSelection ? preparation : {}),
                area, capturedArea: structuredClone(area), areaMode, areaOrigin: "map", areaDescription: context.areaDescription ?? "Area selected on the map.",
                vectorKey: "", vectorInfo: null, drawnPolygonKey: "", selecting: false, selectionError, maskRaster: null,
                vectors: structuredClone(context.vectors ?? []),
            };
        }
    }
    return {id, model, label: model.title, sources, inputs,
        drawnPolygonLayers: model.id === "habitat-condition" ? context.drawnPolygonLayers ?? [] : [],
        temporal: usesTemporal ? createTemporalDraft(context.temporalDatasets ?? [], statisticType,
            statisticType === "temporal_reduction" ? model.steps[0].inputs.precipitation.value : null) : null,
        reduction: statisticType ? {reducer: "mean", percentile: 90} : null,
        parameters: Object.fromEntries(Object.entries(model.parameters).map(([name, parameter]) => [name, parameter.default])),
    };
}

/** Capture the checked model inputs independently of later map and draft edits.
 * Drawn polygon choices are captured as local geometry for the controller to
 * replace with private area references before sending or saving the request.
 * @param {Object} draft Editable model setup with raster and spatial state in inputs[name].
 * @param {string} requestId Stable retry identity generated before dispatch.
 * @param {number} [utcOffsetMinutes=-new Date().getTimezoneOffset()] Local minutes east of UTC, captured once for this submission and its retries.
 * @return {Object} Detached submission with any drawn polygons awaiting upload.
 * @throws {Error} If a required input, label, area or parameter is missing.
 */
export function captureModelSubmission(draft, requestId, utcOffsetMinutes = -new Date().getTimezoneOffset()) {
    if (!draft.label.trim() || [...draft.label.trim()].length > 80) throw new Error("Name this run using 1–80 characters.");
    const inputs = {};
    for (const [name, input] of Object.entries(draft.model.inputs)) {
        const state = draft.inputs[name];
        if (["raster", "catalog_raster", "optional_raster"].includes(input.type))
            inputs[name] = input.type === "optional_raster" && state.raster === null ? null : captureModelRaster(state.raster, draft.sources, input.type);
        else if (input.type === "habitat_stack") inputs[name] = captureHabitatStack(state, draft.sources);
        else if (input.type === "raster_preparation") inputs[name] = captureRasterPreparation(state, draft);
        else if (input.type === "temporal_interval") inputs[name] = captureTemporalInput(draft.temporal, draft.reduction.reducer);
        else if (input.type === "temporal_reduction") inputs[name] = captureTemporalReduction(draft.reduction);
        else if (input.type === "area_statistic") inputs[name] = draft.reduction.reducer;
        else if (["summary_area", "clip_area", "mask_source", "habitat_references"].includes(input.type)) {
            if (state.selecting) throw new Error("Wait for the selected features to finish loading.");
            const startingMask = input.type === "mask_source";
            const references = input.type === "habitat_references";
            if (state.areaMode === "drawnPolygons") {
                const layer = selectedDrawnPolygonLayer(draft, state);
                if (!layer) throw new Error(`Choose a drawn polygon layer for ${input.label.toLowerCase()}.`);
                if (!layer.polygons.length) throw new Error(`No polygons match in ${layer.label}. Add a polygon or change the layer's filter.`);
                inputs[name] = {kind: "drawnPolygons", key: layer.key, polygons: layer.polygons};
            } else if ((startingMask || references) && state.areaMode === "raster") {
                const raster = state.maskRaster;
                inputs[name] = {kind: references ? "raster" : "catalogRaster", source: captureModelRaster(raster, draft.sources, input.type)};
            } else {
                const area = state.area;
                if (!area) throw new Error(state.selectionError || (startingMask ? "Choose the vector features where flow should start." : references ? "Choose the reference sites." : "Choose an analysis area before running the tool."));
                if (!modelSupportsArea(input.type, area)) throw new Error("Choose an area supported by this tool.");
                if (area.kind === "catalogSelection" && state.areaMode !== "captured" &&
                    !state.vectors.some(source => modelSourceKey(source) === modelSourceKey(area.selection)))
                    throw new Error("Add the selected vector layer to Map layers before running this tool.");
                if (["selectedArea", "samplingBox"].includes(area.kind)) modelAreaInput(area);
                else if (area.kind === "catalogSelection") modelAreaInput({kind: area.kind, catalogSelection: area.selection});
                else if (area.kind === "polygonArea") modelAreaInput({kind: area.kind, polygonArea: area.reference});
                inputs[name] = references && area.kind === "catalogSelection"
                    ? {kind: "vector", selection: structuredClone(area.selection)} : structuredClone(area);
            }
        }
        else throw new Error(`This tool requires an input type this interface does not yet support: ${input.type}.`);
    }
    if (getHabitatEarthEngineInput(draft) && Object.entries(draft.model.inputs).some(([name, input]) =>
        input.type === "summary_area" && inputs[name].kind === "wholeRaster"))
        throw new Error("Choose an analysis area for Earth Engine inputs.");
    for (const [name, parameter] of Object.entries(draft.model.parameters)) {
        const value = draft.parameters[name];
        if (parameter.type === "summary_expression" && (typeof value !== "string" || !value.trim())) throw new Error("Enter a summary formula.");
        if (["number", "optional_number"].includes(parameter.type) && !(value === null && parameter.type === "optional_number")) {
            if (!Number.isFinite(value)) throw new Error(`Enter a number for ${parameter.label}.`);
            const unit = parameter.unit ? ` ${parameter.unit}` : "";
            if (parameter.minimum != null && value < parameter.minimum) throw new Error(`${parameter.label} must be at least ${parameter.minimum}${unit}.`);
            if (parameter.exclusiveMinimum != null && value <= parameter.exclusiveMinimum) throw new Error(`${parameter.label} must be greater than ${parameter.exclusiveMinimum}${unit}.`);
        }
    }
    const {id, version, definitionSha256} = draft.model;
    return structuredClone({requestId, model: {id, version, definitionSha256}, inputs, parameters: draft.parameters,
        label: draft.label.trim(), utcOffsetMinutes: utcOffsetMinutes === 0 ? 0 : utcOffsetMinutes});
}
