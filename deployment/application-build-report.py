"""Print application build inputs and loaded native-library versions as JSON.

Run with the image's Python interpreter after installation. The report contains
no environment variables, host paths, credentials, or application data.
"""

import importlib.metadata
import hashlib
import json
from pathlib import Path
import platform
import subprocess

import fiona
import numpy
from osgeo import gdal
import psycopg.pq
import pyproj
import rasterio
import shapely


def build_report() -> dict[str, object]:
    """Collect the installed Python, native, and Debian package identities.

    Returns:
        JSON-compatible build inventory, with sorted distribution names.

    Raises:
        OSError: If the Debian package inventory or OS release file is absent.
        subprocess.CalledProcessError: If Debian package enumeration fails.
    """
    return {
        "build_inputs": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(Path("/app/build-inputs").iterdir())
        },
        "base_images": [
            line.split()[1]
            for line in Path("/app/build-inputs/Dockerfile.app")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.startswith("FROM ")
        ],
        "frontend_tools": Path("/app/build-inputs/frontend-build-versions.txt")
        .read_text(encoding="utf-8")
        .splitlines(),
        "python": platform.python_version(),
        "machine": platform.machine(),
        "libc": list(platform.libc_ver()),
        "os_release": Path("/etc/os-release").read_text(encoding="utf-8"),
        "distributions": dict(
            sorted(
                (distribution.metadata["Name"].lower(), distribution.version)
                for distribution in importlib.metadata.distributions()
            )
        ),
        "native": {
            "fiona_gdal": fiona.__gdal_version__,
            "ogr_gdal": gdal.VersionInfo("RELEASE_NAME"),
            "rasterio_gdal": rasterio.__gdal_version__,
            "rasterio_proj": rasterio.__proj_version__,
            "pyproj_proj": pyproj.proj_version_str,
            "shapely_geos": shapely.geos_version_string,
            "psycopg_libpq": psycopg.pq.version(),
            "numpy_build": numpy.show_config(mode="dicts"),
        },
        "debian_packages": subprocess.check_output(
            ["dpkg-query", "-W", "-f=${Package}=${Version}\\n"], text=True
        ).splitlines(),
    }


if __name__ == "__main__":
    print(json.dumps(build_report(), indent=2, sort_keys=True))
