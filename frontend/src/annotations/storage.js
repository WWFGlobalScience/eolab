/** Device-local annotation persistence with protection against stale tab writes. */
import { readAnnotationLayers, MAX_ANNOTATION_DOCUMENT_BYTES } from "./model.js";

/** Own a versioned IndexedDB document; no annotations are sent to a server. */
export class AnnotationStorage {
    /**
     * Set the browser database provider without opening a connection yet.
     * @param {IDBFactory} [indexedDB=globalThis.indexedDB] Browser database factory.
     */
    constructor(indexedDB = globalThis.indexedDB) {
        this.indexedDB = indexedDB;
        this.database = null;
        this.revision = 0;
    }

    /**
     * Open this origin's annotation database and validate its saved document.
     * @return {Promise<import("./model.js").AnnotationLayer[]>} Saved layers, or an empty collection.
     * @throws {Error} If storage is unavailable or the saved document is invalid.
     */
    async load() {
        if (!this.indexedDB) throw new Error("This browser does not support annotation storage.");
        this.database = await new Promise((resolve, reject) => {
            const request = this.indexedDB.open("eolab-annotations", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("documents");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("Close other EOLab tabs to open annotation storage."));
        });
        this.database.onversionchange = () => { this.database.close(); this.database = null; };
        const saved = await new Promise((resolve, reject) => {
            const request = this.database.transaction("documents").objectStore("documents").get("annotations");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const layers = saved ? readAnnotationLayers(saved.document) : [];
        if (saved && (!Number.isSafeInteger(saved.revision) || saved.revision < 0)) throw new Error("Saved annotation revision is invalid.");
        this.revision = saved?.revision ?? 0;
        return layers;
    }

    /**
     * Atomically save a completed document unless another tab changed it.
     * @param {import("./model.js").AnnotationDocument} document Versioned committed layers; drafts are excluded.
     * @return {Promise<void>} Resolves after the transaction commits.
     * @throws {Error} If storage is full, closed, exceeds the document limit or changed in another tab.
     */
    async save(document) {
        if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_ANNOTATION_DOCUMENT_BYTES) {
            throw new Error("Annotations exceed the 8 MiB device-document limit.");
        }
        if (!this.database) throw new Error("Annotation storage is unavailable. Keep this tab open.");
        const nextRevision = this.revision + 1;
        await new Promise((resolve, reject) => {
            const transaction = this.database.transaction("documents", "readwrite");
            const store = transaction.objectStore("documents");
            let failure = null;
            const request = store.get("annotations");
            request.onsuccess = () => {
                if ((request.result?.revision ?? 0) !== this.revision) {
                    failure = new Error("Annotations changed in another tab. Keep this tab open; these changes have not been saved.");
                    transaction.abort();
                    return;
                }
                store.put({ revision: nextRevision, document }, "annotations");
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Annotation save was interrupted."));
            transaction.onerror = () => reject(transaction.error);
        });
        this.revision = nextRevision;
    }
}
