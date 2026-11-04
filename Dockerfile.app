FROM alpine:3.21.7@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d AS versioner

ARG SOURCE_COMMIT

RUN apk add --no-cache git

WORKDIR /source

RUN if [ "$SOURCE_COMMIT" = "Version cannot be determined outside a Coolify deployment" ]; then \
        printf '%s\n' "$SOURCE_COMMIT" > /version; \
        printf '%s\n' 'unavailable' > /revision; \
    else \
        test -n "$SOURCE_COMMIT" \
        && git init \
        && git remote add origin https://github.com/springinnovate/eolab.git \
        && git fetch --filter=blob:none --tags origin "$SOURCE_COMMIT" \
        && git checkout --detach FETCH_HEAD \
        && git describe --tags --always > /version \
        && git rev-parse HEAD > /revision; \
    fi \
    && test -s /version


FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Shared with backend validation tests; needed when CI tests this build stage.
COPY tests/fixtures/saved-map-v1.json /build/tests/fixtures/saved-map-v1.json
COPY tests/fixtures/saved-map-v2.json /build/tests/fixtures/saved-map-v2.json
COPY tests/fixtures/saved-map-v3-categorical.json /build/tests/fixtures/saved-map-v3-categorical.json
COPY src/eolab_app/annotation_sessions/admin.habitat.html /build/src/eolab_app/annotation_sessions/admin.habitat.html
RUN npm run build \
    && (node --version; npm --version) > /frontend-build-versions.txt


# OGR's Python bindings have no upstream Linux wheels. Build the one reviewed
# source archive against the same pinned GDAL library installed at runtime.
FROM python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS gdal-builder

WORKDIR /build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ libgdal-dev=3.10.3+dfsg-1 \
    && rm -rf /var/lib/apt/lists/*
COPY deployment/application-*-requirements.txt ./
COPY deployment/build-beneficiaries.py deployment/beneficiaries-source.json ./
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
        -r application-build-requirements.txt \
    && sed -n '/^numpy==/p' application-runtime-requirements.txt > numpy-requirements.txt \
    && test -s numpy-requirements.txt \
    && python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
        -r numpy-requirements.txt \
    && test "$(gdal-config --version)" = "3.10.3" \
    && python -m pip wheel --no-cache-dir --no-deps --no-build-isolation \
        --require-hashes --wheel-dir /wheels -r application-gdal-requirements.txt \
    && SETUPTOOLS_SCM_PRETEND_VERSION_FOR_ECOSHARD=0.7.0+g6bd106862a2c \
        python -m pip wheel --no-cache-dir --no-deps --no-build-isolation \
        --require-hashes --wheel-dir /wheels -r application-ecoshard-requirements.txt \
    && python -m pip wheel --no-cache-dir --no-deps --no-build-isolation \
        --require-hashes --wheel-dir /wheels -r application-habitat-requirements.txt \
    && python build-beneficiaries.py --manifest beneficiaries-source.json --output /wheels \
    && (g++ --version; dpkg-query -W) > /gdal-build-packages.txt


FROM python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    GDAL_DISABLE_READDIR_ON_OPEN=TRUE

WORKDIR /app

RUN python -c "import platform, sys; sys.exit(0 if platform.machine() == 'x86_64' else 'Reviewed application wheels require Linux amd64')"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libexpat1 libgdal36=3.10.3+dfsg-1 \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system eolab \
    && adduser --system --ingroup eolab --home /app eolab

COPY deployment/application-*-requirements.txt Dockerfile.app /app/build-inputs/
COPY deployment/build-beneficiaries.py deployment/beneficiaries-source.json /app/build-inputs/
COPY deployment/application-build-report.py /usr/local/bin/application-build-report.py
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
        -r /app/build-inputs/application-build-requirements.txt \
    && python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
        -r /app/build-inputs/application-runtime-requirements.txt

COPY --from=gdal-builder /wheels/ /tmp/gdal-wheels/
COPY --from=gdal-builder /gdal-build-packages.txt /app/build-inputs/
RUN python -m pip install --no-cache-dir --no-index --no-deps /tmp/gdal-wheels/*.whl \
    && rm -rf /tmp/gdal-wheels

COPY pyproject.toml README.md LICENSE ./
COPY src/ ./src/
COPY --chmod=0555 deployment/require-read-only-scan-source.sh \
    /usr/local/bin/require-read-only-scan-source
COPY --from=frontend-builder /build/frontend/dist/ ./src/eolab_app/static/
COPY --from=frontend-builder /frontend-build-versions.txt /app/build-inputs/
COPY --from=versioner /version /app/version
COPY --from=versioner /revision /app/revision

RUN python -m pip install --no-cache-dir --no-index --no-build-isolation \
        --check-build-dependencies --no-deps . \
    && python -m pip check \
    && cd /tmp && python -c "from eolab_app.processing.model_definitions import ModelRegistry; assert ModelRegistry.load_installed().list_models()" && cd /app \
    && python -c "from eolab_app.processing.downstream_runner import load_beneficiaries; assert callable(load_beneficiaries().calculate_downstream_coverage_from_conditional_raster)" \
    && python -c "from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition" \
    && python -c "import fiona; import rasterio; assert 'ESRI Shapefile' in fiona.supported_drivers; from osgeo import ogr, gdal_array; assert hasattr(ogr.Layer, 'GetArrowStreamAsNumPy'); from ecoshard.geoprocessing import routing; assert callable(routing.flow_dir_mfd)" \
    && python /usr/local/bin/application-build-report.py > /app/build-environment.json \
    && mkdir -p /processing-data /vector-uploads \
    && chown -R eolab:eolab /app /processing-data /vector-uploads

USER eolab

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]

ENTRYPOINT ["/usr/local/bin/require-read-only-scan-source"]
CMD ["uvicorn", "eolab_app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
