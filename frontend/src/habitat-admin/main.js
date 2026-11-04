/** Compose the Habitat administration page without loading the map application. */
import { HabitatAdminApi } from "./api.js";
import { HabitatAdminController } from "./controller.js";
import { HabitatAdminView } from "./view.js";

let recoveryStorage = null;
try { recoveryStorage = globalThis.localStorage; } catch { /* Storage may be disabled by the browser. */ }

const controller = new HabitatAdminController({
    api: new HabitatAdminApi(),
    view: new HabitatAdminView(document),
    storage: recoveryStorage,
});
void controller.start();
