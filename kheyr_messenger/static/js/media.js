/* ============================================================
   MediaCache — decrypts attachments into LRU blob URLs
   ============================================================ */
(function () {
    'use strict';

    const MAX = 24;
    const urls = new Map();      // key -> objectURL
    const order = [];            // LRU keys
    const inflight = new Map();  // key -> promise

    function touch(key) {
        const i = order.indexOf(key);
        if (i >= 0) order.splice(i, 1);
        order.push(key);
        while (order.length > MAX) {
            const old = order.shift();
            const u = urls.get(old);
            if (u) { try { URL.revokeObjectURL(u); } catch (e) {} urls.delete(old); }
        }
    }

    async function decryptToBlob(payload, keyPair, myId) {
        const resp = await fetch('/api/file/' + payload.file_id + '/download/', { credentials: 'same-origin' });
        if (!resp.ok) throw new Error('download ' + resp.status);
        const buf = await resp.arrayBuffer();
        const ek = (payload.encrypted_keys || {})[String(myId)];
        if (!ek) throw new Error('not-addressed-to-you');
        const pt = await CryptoHelpers.decryptFile(buf, payload.file_iv || payload.iv, ek, keyPair);
        return new Blob([pt], { type: payload.mime_type || 'application/octet-stream' });
    }

    const MediaCache = {
        /* payload: message_payload() shape with file_id/iv/encrypted_keys/mime_type */
        async url(payload, keyPair, myId) {
            const key = 'f' + payload.file_id;
            if (urls.has(key)) { touch(key); return urls.get(key); }
            if (inflight.has(key)) return inflight.get(key);
            const p = decryptToBlob(payload, keyPair, myId).then(blob => {
                const u = URL.createObjectURL(blob);
                urls.set(key, u); touch(key);
                inflight.delete(key);
                return u;
            }).catch(e => { inflight.delete(key); throw e; });
            inflight.set(key, p);
            return p;
        },

        async blob(payload, keyPair, myId) {
            const u = await this.url(payload, keyPair, myId);
            const r = await fetch(u);
            return r.blob();
        },

        peek(fileId) { return urls.get('f' + fileId) || null; },

        drop(fileId) {
            const k = 'f' + fileId, u = urls.get(k);
            if (u) { try { URL.revokeObjectURL(u); } catch (e) {} urls.delete(k); order.splice(order.indexOf(k), 1); }
        },

        /* read intrinsic metadata of a media blob without uploading anything */
        probe(blob, kind) {
            return new Promise((resolve) => {
                const out = { duration_ms: null, width: null, height: null };
                const done = () => resolve(out);
                const timer = setTimeout(done, 6000);
                const url = URL.createObjectURL(blob);
                if (kind === 'image') {
                    const im = new Image();
                    im.onload = () => { out.width = im.naturalWidth; out.height = im.naturalHeight;
                        clearTimeout(timer); URL.revokeObjectURL(url); done(); };
                    im.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); done(); };
                    im.src = url;
                } else {
                    const v = document.createElement(kind === 'video' ? 'video' : 'audio');
                    v.preload = 'metadata';
                    v.onloadedmetadata = () => {
                        out.duration_ms = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null;
                        if (v.videoWidth) { out.width = v.videoWidth; out.height = v.videoHeight; }
                        clearTimeout(timer); URL.revokeObjectURL(url); done();
                    };
                    v.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); done(); };
                    v.src = url;
                }
            });
        },

        kindOf(mime, forced) {
            if (forced && forced !== 'file') return forced;
            mime = (mime || '').toLowerCase();
            if (mime.startsWith('image/')) return 'image';
            if (mime.startsWith('video/')) return 'video';
            if (mime.startsWith('audio/')) return 'audio';
            return 'file';
        },

        isMusic(mime, name) {
            mime = (mime || '').toLowerCase();
            if (mime.startsWith('audio/')) return mime.indexOf('webm') < 0;
            return /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(name || '');
        },    };

    window.MediaCache = MediaCache;
})();
