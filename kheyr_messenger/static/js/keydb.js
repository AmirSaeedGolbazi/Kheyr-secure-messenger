const KeyDB = {
    _dbPromise: null,

    _open() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open('kheyr_keys_v2', 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains('keys')) {
                    req.result.createObjectStore('keys');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._dbPromise;
    },

    async set(name, value) {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(value, name);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async get(name) {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('keys', 'readonly');
            const req = tx.objectStore('keys').get(name);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    },

    async clear() {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('keys', 'readwrite');
            tx.objectStore('keys').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
};