package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.vfny.geoserver.crs.GeoserverOverridingWKTFactory.SYSTEM_DEFAULT_USER_PROJ_FILE;

import java.nio.file.Path;
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.referencing.CRS;
import org.junit.jupiter.api.Test;

/** Read an EPSG-coded equal-area GeoTIFF and compare its coordinates with PROJ. */
final class Epsg6933Test {
    /** Preserve the native grid and samples while transforming coordinates accurately. */
    @Test
    void readsNativeGridAndMatchesProjCoordinates() throws Exception {
        String previous = System.getProperty(SYSTEM_DEFAULT_USER_PROJ_FILE);
        try {
            System.setProperty(SYSTEM_DEFAULT_USER_PROJ_FILE,
                    Path.of("..", "epsg_overrides.properties").toAbsolutePath().toString());
            CRS.reset("all");
            var reader = new GeoTiffReader(Epsg6933Test.class.getResource("/epsg-6933.tif"));
            try {
                var coverage = reader.read();
                assertEquals(6933, CRS.lookupEpsgCode(coverage.getCoordinateReferenceSystem(), false));
                assertEquals(-10421000, coverage.getEnvelope2D().getMinX());
                assertEquals(5441500, coverage.getEnvelope2D().getMinY());
                assertEquals(4000, coverage.getEnvelope2D().getWidth());
                assertEquals(4000, coverage.getEnvelope2D().getHeight());
                var image = coverage.getRenderedImage();
                assertEquals(8, image.getWidth());
                assertEquals(8, image.getHeight());
                assertEquals(0, image.getData().getSampleDouble(0, 0, 0));
                assertEquals(62, image.getData().getSampleDouble(6, 7, 0));
                assertEquals(-9999, image.getData().getSampleDouble(7, 7, 0));

                // Independent pyproj/PROJ values, with longitude first and metre tolerance.
                double[] geographic = {0, 0, -108, 48, 120, -30, 15, 85};
                double[] expected = {0, 0, -10420518.267096823, 5445383.869156103,
                        11578353.63010758, -3658789.3248550068,
                        1447294.2037634475, 7314040.889811971};
                double[] actual = new double[expected.length];
                var transform = CRS.findMathTransform(
                        CRS.decode("EPSG:4326", true), coverage.getCoordinateReferenceSystem());
                transform.transform(geographic, 0, actual, 0, geographic.length / 2);
                for (int index = 0; index < actual.length; index++) {
                    assertEquals(expected[index], actual[index], 0.001);
                }
            } finally {
                reader.dispose();
            }
        } finally {
            if (previous == null) {
                System.clearProperty(SYSTEM_DEFAULT_USER_PROJ_FILE);
            } else {
                System.setProperty(SYSTEM_DEFAULT_USER_PROJ_FILE, previous);
            }
            CRS.reset("all");
        }
    }
}
