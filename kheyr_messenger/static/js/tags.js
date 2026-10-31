/* ============================================================
   Tags — reads audio metadata (title/artist/album/…) from the
   sender's plaintext file before it is encrypted. Pure parsing
   functions touch no DOM so they can be unit-tested outside a
   browser; the DOM helpers (data URLs, fetch) are separate.
   ============================================================ */
(function (global) {
    'use strict';

    /* ---------- byte readers ---------- */
    const cache = new Map();     /* file_id → decrypted tags */
    const pending = new Map();   /* file_id → in-flight promise */

    function be16(u, o) { return (u[o] << 8) | u[o + 1]; }
    function be32(u, o) { return (((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0); }
    function le32(u, o) { return (((u[o + 3] << 24) | (u[o + 2] << 16) | (u[o + 1] << 8) | u[o]) >>> 0); }
    function be24(u, o) { return (u[o] << 16) | (u[o + 1] << 8) | u[o + 2]; }
    function synchsafe(u, o) { return ((u[o] << 21) | (u[o + 1] << 14) | (u[o + 2] << 7) | u[o + 3]) >>> 0; }

    function str(u, o, n) {
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(u[o + i]);
        return s;
    }
    function cut(s) { return s.replace(/\u0000+$/, '').trim(); }
    function utf8(u) {
        if (typeof TextDecoder !== 'undefined') {
            try { return new TextDecoder('utf-8').decode(u); } catch (e) {}
        }
        return cut(str(u, 0, u.length));
    }

    /* one ID3v2 text frame may hold several NUL-separated values */
    function decodeId3Text(u, enc) {
        let s;
        if (enc === 1) {
            if (typeof TextDecoder !== 'undefined') {
                try { s = new TextDecoder('utf-16').decode(u); } catch (e) { s = utf8(u); }
            } else s = utf8(u);
        } else if (enc === 2) {
            if (typeof TextDecoder !== 'undefined') {
                try { s = new TextDecoder('utf-16be').decode(u); } catch (e) { s = utf8(u); }
            } else s = utf8(u);
        } else if (enc === 3) {
            s = utf8(u);
        } else {
            /* latin-1 */
            let out = '';
            for (let i = 0; i < u.length; i++) out += String.fromCharCode(u[i]);
            s = out;
        }
        const parts = s.split('\u0000').map(cut).filter(Boolean);
        return parts.length ? parts.join(' / ') : '';
    }

    /* ID3v1 numeric genre table, only used when TCON holds a bare number */
    const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge',
        'Hip Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap',
        'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal',
        'Pranks', 'Soundtrack', 'Euro-Techno', 'Voice', 'Prim&Prog', 'Fusion', 'Breakdance',
        'Standards', 'Electronic', 'Folk', 'Afrofolk', 'Jazz+Funk', 'Bebop', 'Rock & Roll',
        'Hard', 'Acid', 'House', 'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Satyr',
        'Sonata', 'Song', 'Wave', 'Hum', 'Conversation', 'New Ambient', 'Instrumental'];
    function genreOf(v) {
        const m = /^\((\d{1,3})\)(.*)$/.exec(v || '');
        if (m) return cut(m[2]) || GENRES[+m[1]] || '';
        if (/^\d{1,3}$/.test(v || '')) return GENRES[+v] || '';
        return v || '';
    }

    function blank() {
        return { title: '', artist: '', albumArtist: '', album: '', track: null, disc: null,
            year: '', genre: '', composer: '', cover: null };
    }
    function isBlank(t) {
        return !(t.title || t.artist || t.album || t.albumArtist || t.genre || t.year ||
            t.track || t.disc || t.composer || t.cover);
    }

    /* 0xFF 0x00 sequences are an escape, not data — undo them before parsing */
    function desynchronise(u) {
        const out = new Uint8Array(u.length);
        let n = 0;
        for (let i = 0; i < u.length; i++) {
            out[n++] = u[i];
            if (u[i] === 0xFF && u[i + 1] === 0x00) i++;
        }
        return out.subarray(0, n);
    }

    /* ---------- ID3v2 ---------- */
    const ID3_MAP = {
        TIT2: 'title', TT2: 'title',
        TPE1: 'artist', TP1: 'artist',
        TPE2: 'albumArtist', TP2: 'albumArtist',
        TALB: 'album', TAL: 'album',
        TRCK: 'track', TRK: 'track',
        TPOS: 'disc', TSP: 'disc',
        TYER: 'year', YE: 'year', TDRC: 'year',
        TCON: 'genre', TCO: 'genre',
        TCM2: 'composer', TCM: 'composer',
    };

    function parseId3v2(u, at) {
        if (str(u, at, 3) !== 'ID3') return null;
        const ver = u[at + 3];
        if (ver < 2 || ver > 4) return null;
        /* header: 'ID3' + version(2 bytes) + flags(1) + synchsafe size(4) */
        const flags = u[at + 5];
        const size = synchsafe(u, at + 6);
        let body = u.subarray(at + 10, Math.min(u.length, at + 10 + size));
        if (flags & 0x80) body = desynchronise(body);

        const tag = blank();
        const wide = ver >= 3;
        let p = 0;
        if ((flags & 0x40) && body.length >= 4) {
            /* extended header: v2.3 counts itself, v2.4 uses synchsafe and excludes itself */
            p = wide && ver === 3 ? 4 + be32(body, 0) : synchsafe(body, 0);
        }
        while (p + (wide ? 10 : 6) <= body.length) {
            const id = str(body, p, wide ? 4 : 3);
            if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
            let len;
            if (!wide) len = be24(body, p + 3);
            else if (ver === 4) len = synchsafe(body, p + 4);
            else len = be32(body, p + 4);
            const data = body.subarray(p + (wide ? 10 : 6), p + (wide ? 10 : 6) + len);
            if (len <= 0 || data.length < len) break;

            const key = ID3_MAP[id];
            if (key && data.length) {
                const enc = data[0];
                let v = decodeId3Text(data.subarray(1), enc);
                if (key === 'track' || key === 'disc') {
                    const n = parseInt(v, 10);
                    v = Number.isFinite(n) ? n : null;
                } else if (key === 'year') {
                    v = (v.match(/\d{4}/) || [''])[0];
                } else if (key === 'genre') {
                    v = genreOf(v);
                }
                if (v) tag[key] = v;
            } else if ((id === 'APIC' || id === 'PIC') && !tag.cover) {
                const c = parseApic(data, id === 'PIC');
                if (c) tag.cover = c;
            }
            p += (wide ? 10 : 6) + len;
        }
        return tag;
    }

    function parseApic(d, v22) {
        const enc = d[0];
        let p = 1, mime;
        if (v22) {
            mime = str(d, p, 3).toUpperCase() === 'PNG' ? 'image/png' : 'image/jpeg';
            p += 3;
        } else {
            let end = p;
            while (end < d.length && d[end] !== 0) end++;
            mime = utf8(d.subarray(p, end)) || 'image/jpeg';
            p = end + 1;
        }
        p += 1;                       /* picture type byte */
        const term = enc === 1 || enc === 2 ? '\u0000\u0000' : '\u0000';
        let end = p;
        while (end < d.length && str(d, end, term.length) !== term) end++;
        const bytes = d.subarray(Math.min(d.length, end + term.length));
        if (!bytes.length) return null;
        return { mime: mime, bytes: bytes };
    }

    function parseId3v1(u) {
        if (u.length < 128 || str(u, u.length - 128, 3) !== 'TAG') return null;
        const b = u.length - 128;
        const tag = blank();
        tag.title = cut(utf8(u.subarray(b + 3, b + 33)));
        tag.artist = cut(utf8(u.subarray(b + 33, b + 63)));
        tag.album = cut(utf8(u.subarray(b + 63, b + 93)));
        tag.year = cut(utf8(u.subarray(b + 93, b + 97)));
        tag.genre = GENRES[u[b + 127]] || '';
        /* v1.1 borrows the last two comment bytes for a track number */
        if (u[b + 125] === 0 && u[b + 126] !== 0) tag.track = u[b + 126];
        return tag;
    }

    /* ---------- MP4 / M4A ---------- */
    const MP4_MAP = {
        '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album',
        'aART': 'albumArtist', '\u00a9day': 'year', '\u00a9gen': 'genre',
        'gnre': 'genre', '\u00a9wrt': 'composer', 'trkn': 'track', 'disk': 'disc',
        'covr': 'cover',
    };

    function mp4Data(d) {
        /* an atom's payload starts with a "data" atom: size type ver+flags reserved */
        if (d.length < 16 || be32(d, 4) !== 0x64617461 /* data */) return null;
        return { bytes: d.subarray(16), flags: be32(d, 8) & 0xffffff };
    }

    function mp4Mime(d) {
        if (d.flags === 14) return 'image/png';
        if (d.flags === 13) return 'image/jpeg';
        if (d.bytes[0] === 0x89) return 'image/png';
        return 'image/jpeg';
    }

    function parseMp4(u) {
        const tag = blank();
        walk(u, 0, u.length, tag, 0);
        return isBlank(tag) ? null : tag;
    }

    function walk(u, from, to, tag, depth) {
        if (depth > 6) return;
        let p = from;
        while (p + 8 <= to) {
            let size = be32(u, p);
            const type = str(u, p + 4, 4);
            let head = 8;
            if (size === 1) { size = be32(u, p + 16); head = 24; }
            if (size === 0) size = to - p;
            if (size < head || p + size > to) break;
            const body = u.subarray(p + head, p + size);
            const end = p + size;

            if (type === 'moov' || type === 'udta' || type === 'ilst') {
                walk(body, 0, body.length, tag, depth + 1);
            } else if (type === 'meta') {
                walk(body, 4, body.length, tag, depth + 1);   /* meta is a full box */
            } else if (MP4_MAP[type]) {
                const d = mp4Data(body);
                const key = MP4_MAP[type];
                if (d) {
                    if (key === 'cover') {
                        if (d.bytes.length) tag.cover = { mime: mp4Mime(d), bytes: d.bytes };
                    } else if (key === 'track' || key === 'disc') {
                        if (d.bytes.length >= 4) tag[key] = be16(d.bytes, 2);
                    } else if (d.flags === 1 || d.flags === 2 || d.flags === 0) {
                        const v = cut(utf8(d.bytes));
                        if (v) {
                            if (key === 'year') tag.year = (v.match(/\d{4}/) || [''])[0];
                            else if (key === 'genre' && d.flags === 0) tag.genre = GENRES[be16(d.bytes, 0) - 1] || '';
                            else tag[key] = v;
                        }
                    }
                }
            }
            p = end;
        }
    }

    /* ---------- Ogg (Vorbis / Opus) ---------- */
    function oggPackets(u, limit) {
        const out = [];
        let p = 0, cur = null;
        while (p + 27 <= u.length && out.length < limit) {
            if (str(u, p, 4) !== 'OggS') break;
            const nseg = u[p + 26];
            let segSum = 0;
            for (let i = 0; i < nseg; i++) segSum += u[p + 27 + i];
            const bodyAt = p + 27 + nseg;
            if (bodyAt + segSum > u.length) break;
            let q = bodyAt;
            for (let i = 0; i < nseg; i++) {
                const l = u[p + 27 + i];
                const part = u.subarray(q, q + l);
                cur = cur ? concat(cur, part) : part;
                q += l;
                if (l < 255) { out.push(cur); cur = null; }
            }
            p = bodyAt + segSum;
        }
        return out;
    }

    function concat(a, b) {
        const o = new Uint8Array(a.length + b.length);
        o.set(a, 0); o.set(b, a.length);
        return o;
    }

    function vorbisComments(d, at, tag) {
        let p = at;
        const vl = le32(d, p); p += 4;
        p += vl;                                   /* vendor, unused */
        const n = le32(d, p); p += 4;
        for (let i = 0; i < n && p + 4 <= d.length; i++) {
            const l = le32(d, p); p += 4;
            const kv = utf8(d.subarray(p, p + l)); p += l;
            const eq = kv.indexOf('=');
            if (eq < 0) continue;
            const k = kv.slice(0, eq).toUpperCase(), v = cut(kv.slice(eq + 1));
            if (!v) continue;
            if (k === 'TITLE') tag.title = v;
            else if (k === 'ARTIST') tag.artist = tag.artist ? tag.artist + ' / ' + v : v;
            else if (k === 'ALBUM') tag.album = v;
            else if (k === 'ALBUMARTIST') tag.albumArtist = v;
            else if (k === 'DATE') tag.year = (v.match(/\d{4}/) || [''])[0];
            else if (k === 'GENRE') tag.genre = tag.genre ? tag.genre + ', ' + v : v;
            else if (k === 'TRACKNUMBER') tag.track = parseInt(v, 10) || null;
            else if (k === 'DISCNUMBER') tag.disc = parseInt(v, 10) || null;
            else if (k === 'COMPOSER') tag.composer = v;
        }
        return p;
    }

    function flacPicture(d) {
        let p = 0;
        p += 4;                                    /* picture type */
        const ml = be32(d, p); p += 4;
        const mime = utf8(d.subarray(p, p + ml)) || 'image/jpeg'; p += ml;
        const dl = be32(d, p); p += 4; p += dl;
        p += 4 + 4 + 4 + 4;                         /* w, h, depth, colours */
        const bl = be32(d, p); p += 4;
        const bytes = d.subarray(p, p + bl);
        return bytes.length ? { mime: mime, bytes: bytes } : null;
    }

    function parseOgg(u, tag) {
        const pk = oggPackets(u, 24);
        for (const d of pk) {
            if (d.length > 7 && d[0] === 0x03 && str(d, 1, 6) === 'vorbis') {
                vorbisComments(d, 7, tag);
            } else if (d.length > 8 && str(d, 0, 8) === 'OpusTags') {
                vorbisComments(d, 8, tag);
            } else if (d.length > 7 && d[0] === 0x06 && str(d, 1, 6) === 'vorbis') {
                if (!tag.cover) tag.cover = flacPicture(d.subarray(8));
            }
        }
        return isBlank(tag) ? null : tag;
    }

    /* ---------- FLAC ---------- */
    function parseFlac(u, tag) {
        let p = 4;
        while (p + 4 <= u.length) {
            const last = (u[p] & 0x80) !== 0;
            const type = u[p] & 0x7f;
            const len = be24(u, p + 1);
            const d = u.subarray(p + 4, p + 4 + len);
            if (d.length < len) break;
            if (type === 4) vorbisComments(d, 0, tag);
            else if (type === 6 && !tag.cover) tag.cover = flacPicture(d);
            p += 4 + len;
            if (last) break;
        }
        return isBlank(tag) ? null : tag;
    }

    /* ---------- RIFF / WAVE ---------- */
    const RIFF_MAP = {
        INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre',
        ICRD: 'year', ITRK: 'track', IMAR: 'albumArtist', ICMT: 'composer',
    };

    function parseRiff(u, tag) {
        let p = 12;
        while (p + 8 <= u.length) {
            const id = str(u, p, 4);
            const size = le32(u, p + 4);
            const body = u.subarray(p + 8, p + 8 + size);
            if (id === 'LIST' && str(body, 0, 4) === 'INFO') {
                let q = 4;
                while (q + 8 <= body.length) {
                    const cid = str(body, q, 4);
                    const cs = le32(body, q + 4);
                    const v = cut(utf8(body.subarray(q + 8, q + 8 + cs)));
                    const key = RIFF_MAP[cid];
                    if (key && v) {
                        if (key === 'year') tag.year = (v.match(/\d{4}/) || [''])[0];
                        else if (key === 'track' || key === 'disc') tag[key] = parseInt(v, 10) || null;
                        else tag[key] = v;
                    }
                    q += 8 + cs + (cs & 1);
                }
            } else if (id === 'id3 ' || id === 'ID3 ') {
                const t = parseId3v2(body, 0);
                if (t) merge(tag, t);
            }
            if (size < 0) break;
            p += 8 + size + (size & 1);
        }
        return isBlank(tag) ? null : tag;
    }

    function merge(into, from) {
        Object.keys(from).forEach(k => {
            if (k === 'cover') { if (!into.cover && from.cover) into.cover = from.cover; }
            else if (!into[k] && from[k]) into[k] = from[k];
        });
        return into;
    }

    /* ---------- entry point ---------- */
    function parse(buf, name) {
        const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const tag = blank();
        let found = null;
        if (str(u, 0, 3) === 'ID3') found = parseId3v2(u, 0);
        else if (str(u, 0, 4) === 'fLaC') found = parseFlac(u, tag);
        else if (str(u, 0, 4) === 'OggS') found = parseOgg(u, tag);
        else if (str(u, 0, 4) === 'RIFF') found = parseRiff(u, tag);
        else if (str(u, 4, 4) === 'ftyp') found = parseMp4(u);
        if (found) merge(tag, found);
        const v1 = parseId3v1(u);
        if (v1) merge(tag, v1);
        if (!tag.title && name) tag.title = cut(name.replace(/\.[a-z0-9]+$/i, ''));
        return tag;
    }

    /* ---------- browser side ---------- */
    function toB64(u) {
        let s = '';
        for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
        return btoa(s);
    }

    const MAX_ART = 420;      /* px */
    async function shrink(cover) {
        const blob = new Blob([cover.bytes], { type: cover.mime });
        if (typeof createImageBitmap === 'function') {
            const bmp = await createImageBitmap(blob);
            const scale = Math.min(1, MAX_ART / Math.max(bmp.width, bmp.height));
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(bmp.width * scale));
            cv.height = Math.max(1, Math.round(bmp.height * scale));
            cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
            bmp.close && bmp.close();
            const data = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.82));
            return { mime: 'image/jpeg', data: toB64(new Uint8Array(await data.arrayBuffer())) };
        }
        if (blob.size > 400 * 1024) return null;
        return { mime: cover.mime, data: toB64(cover.bytes) };
    }

    const Tags = {
        parse: parse,
        parseId3v2: parseId3v2,
        parseId3v1: parseId3v1,

        /* plaintext file → the JSON that will be sealed next to the audio */
        async read(file) {
            const t = parse(await file.arrayBuffer(), file.name);
            const out = {
                title: t.title, artist: t.artist, albumArtist: t.albumArtist, album: t.album,
                track: t.track, disc: t.disc, year: t.year, genre: t.genre, composer: t.composer,
            };
            if (t.cover) {
                try { out.cover = await shrink(t.cover); } catch (e) { out.cover = null; }
            }
            Object.keys(out).forEach(k => { if (!out[k]) delete out[k]; });
            return isBlankValues(out) ? null : out;
        },

        /* encrypted sidecar → plain tags, cached per file */
        async load(payload, keyPair, myId) {
            const id = payload.file_id;
            if (cache.has(id)) return cache.get(id);
            if (pending.has(id)) return pending.get(id);
            const p = (async () => {
                const res = await fetch('/api/file/' + id + '/meta/', { credentials: 'same-origin' });
                if (!res.ok) return null;
                const body = await res.json();
                const env = body && body.meta;
                if (!env || !env.data) return null;
                const ek = (payload.encrypted_keys || {})[String(myId)];
                if (!ek) return null;
                return await CryptoHelpers.openMeta(env, ek, keyPair);
            })().then(v => { cache.set(id, v); pending.delete(id); return v; })
                .catch(e => { pending.delete(id); throw e; });
            pending.set(id, p);
            return p;
        },

        peek(fileId) { return cache.get(fileId) || null; },
        drop(fileId) { cache.delete(fileId); },
    };

    function isBlankValues(o) {
        return !(o.title || o.artist || o.album || o.albumArtist || o.genre || o.year ||
            o.track || o.disc || o.composer || o.cover);
    }

    global.Tags = Tags;
})(typeof globalThis !== 'undefined' ? globalThis : this);

