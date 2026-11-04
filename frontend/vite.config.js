import { fileURLToPath } from "node:url";

/** Build the map and the independent, authenticated Habitat administration entry. */
export default {
    build: {
        rolldownOptions: {
            input: {
                index: fileURLToPath(new URL("./index.html", import.meta.url)),
                habitatAdmin: fileURLToPath(new URL("./src/habitat-admin/main.js", import.meta.url)),
            },
            output: {
                /** Keep the protected admin script address stable; map entries retain hashes.
                 * @param {{name:string}} chunk Bundler entry metadata.
                 * @returns {string} Filename used by the existing authenticated asset route.
                 */
                entryFileNames: chunk => chunk.name === "habitatAdmin"
                    ? "assets/habitat-admin.js" : "assets/[name]-[hash].js",
            },
        },
    },
};
