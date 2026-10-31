/* ============================================================
   Player — in-app music queue + Media Session + mini player
   ============================================================ */
(function () {
    'use strict';

    const el = {};
    let audio = null, queue = [], idx = -1, shuffle = false, repeat = 'off';
    let onAnyStop = null;

    function bind() {
        if (audio) return;
        el.wrap = UI.q('#mini-player');
        el.title = UI.q('#mp-title');
        el.artist = UI.q('#mp-artist');
        el.art = UI.q('#mp-art');
        el.discIcon = UI.q('#mp-disc-icon');
        el.fill = UI.q('#mp-fill');
        el.prog = UI.q('#mp-progress');
        el.cur = UI.q('#mp-cur');
        el.dur = UI.q('#mp-dur');
        el.play = UI.q('#mp-play');
        el.prev = UI.q('#mp-prev');
        el.next = UI.q('#mp-next');
        el.close = UI.q('#mp-close');

        audio = new Audio();
        audio.preload = 'auto';
        audio.addEventListener('timeupdate', tick);
        audio.addEventListener('loadedmetadata', tick);
        audio.addEventListener('durationchange', tick);
        audio.addEventListener('play', () => Player.syncIcon());
        audio.addEventListener('pause', () => Player.syncIcon());
        audio.addEventListener('ended', () => {
            if (repeat === 'one') { audio.currentTime = 0; audio.play(); }
            else step(1, true);
        });
        audio.addEventListener('error', () => Player.stop());

        el.play.addEventListener('click', Player.toggle);
        el.next.addEventListener('click', () => step(1));
        el.prev.addEventListener('click', () => step(-1));
        el.close.addEventListener('click', () => Player.stop());
        el.prog.addEventListener('click', (e) => {
            if (!audio.duration) return;
            const r = el.prog.getBoundingClientRect();
            const ratio = 1 - ((e.clientX - r.left) / r.width); // RTL bar
            audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
        });
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => Player.toggle());
            navigator.mediaSession.setActionHandler('pause', () => Player.toggle());
            navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
            navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
            navigator.mediaSession.setActionHandler('stop', () => Player.stop());
        }
        Player.syncIcon();
    }

    function tick() {
        if (!el.fill || !audio.duration) return;
        el.fill.style.width = ((audio.currentTime / audio.duration) * 100).toFixed(2) + '%';
        if (el.cur) el.cur.textContent = UI.mmss(audio.currentTime * 1000);
        if (el.dur) el.dur.textContent = UI.mmss(audio.duration * 1000);
    }

    function artFor(t) {
        if (!t.artwork) return [];
        return Array.isArray(t.artwork) ? t.artwork
            : [{ src: t.artwork, sizes: '512x512', type: 'image/jpeg' }];
    }

    function current() { return queue[idx] || null; }

    /* one place draws every tag field so the bubble and the bar agree */
    function paint(t) {
        if (el.title) el.title.textContent = t.title || 'بی‌نام';
        if (el.artist) {
            const bits = [];
            if (t.artist) bits.push(t.artist);
            if (t.album) bits.push(t.album);
            if (t.year) bits.push('(' + t.year + ')');
            el.artist.textContent = bits.join(' — ');
            el.artist.style.display = bits.length ? '' : 'none';
        }
        const src = artFor(t)[0] && artFor(t)[0].src;
        if (el.art && el.discIcon) {
            if (src) {
                el.art.src = src;
                el.art.classList.add('on');
                el.discIcon.style.display = 'none';
            } else {
                el.art.classList.remove('on');
                el.art.removeAttribute('src');
                el.discIcon.style.display = '';
            }
        }
        if (el.dur) el.dur.textContent = UI.mmss(t.duration_ms || 0);
        if (el.cur) el.cur.textContent = '0:00';
        if (el.fill) el.fill.style.width = '0';
    }

    function load(i, autoplay) {
        const t = queue[i];
        if (!t) return;
        idx = i;
        if (onAnyStop) onAnyStop();
        audio.src = t.url;
        audio.playbackRate = 1;
        paint(t);
        if (el.wrap) el.wrap.classList.add('show');
        if (autoplay) audio.play().catch(() => {});
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: t.title || 'بی‌نام', artist: t.artist || 'خیر',
                    album: t.album || 'پخش موسیقی', artwork: artFor(t),
                });
            } catch (e) {}
        }
    }

    function step(dir, auto) {
        if (!queue.length) return;
        let n = idx;
        if (shuffle && queue.length > 1) {
            while (n === idx) n = Math.floor(Math.random() * queue.length);
        } else {
            n = idx + dir;
            if (n >= queue.length) n = 0;
            if (n < 0) n = queue.length - 1;
        }
        load(n, auto ? true : true);
    }

    const Player = {
        get playing() { return !!audio && !audio.paused; },
        get src() { return audio ? audio.src : ''; },
        get live() { return audio; },

        set onStop(fn) { onAnyStop = fn; },

        /* tracks: [{url, title, artist, fileId}] */
        enqueue(tracks, startIndex) {
            bind();
            const fresh = (tracks || []).filter(t => t && t.url);
            if (!fresh.length) return;
            queue = fresh.slice();
            idx = Math.max(0, Math.min(queue.length - 1, startIndex || 0));
            load(idx, true);
        },

        /* append a single track to the running queue, or focus the one already there */
        append(track) {
            bind();
            if (!track || !track.url) return;
            const at = track.fileId == null ? -1 : queue.findIndex(t => t.fileId === track.fileId);
            if (at >= 0) {
                if (idx === at) audio.play().catch(() => {});
                else load(at, true);
                return;
            }
            queue.push(track);
            if (idx < 0) load(queue.length - 1, true);
        },

        toggle() {
            bind();
            if (!audio || !current()) return;
            if (audio.paused) audio.play().catch(() => {}); else audio.pause();
            Player.syncIcon();
        },
        pause() { if (audio) audio.pause(); Player.syncIcon(); },

        syncIcon() {
            if (!el.play) return;
            const name = Player.playing ? 'pause' : 'play';
            el.play.innerHTML = '<svg class="icon"><use href="#i-' + name + '"/></svg>';
        },

        stop() {
            if (!audio) return;
            audio.pause(); audio.removeAttribute('src'); audio.load();
            queue = []; idx = -1;
            if (el.wrap) el.wrap.classList.remove('show');
            if (el.art && el.discIcon) { el.art.classList.remove('on'); el.discIcon.style.display = ''; }
            if (el.artist) el.artist.textContent = '';
            if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch (e) {} }
        },

        has(url) { return queue.some(t => t.url === url); },
        get queue() { return queue; },
        get index() { return idx; },

        toggleShuffle() { shuffle = !shuffle; return shuffle; },
        cycleRepeat() {
            repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
            return repeat;
        },
    };

    window.Player = Player;
})();
