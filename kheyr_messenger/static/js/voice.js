/* ============================================================
   Voice — recorder (opus), level meter, waveform playback
   ============================================================ */
(function () {
    'use strict';

    let live = null;         // {audio, btn, wave, stop}
    let rec = null;          // {mr, stream, chunks, started, timer, raf}

    function stopLive() {
        if (!live) return;
        try { live.audio.pause(); } catch (e) {}
        if (live.btn) live.btn.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>';
        if (live.wave) UI.qa('i', live.wave).forEach(b => b.classList.remove('done'));
        const l = live; live = null;
        if (l && l.stop) l.stop();
    }

    function bars(container, count) {
        container.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const b = document.createElement('i');
            const h = 18 + Math.abs(Math.sin(i * 1.7)) * 60 + Math.random() * 22;
            b.style.height = Math.min(100, h) + '%';
            container.appendChild(b);
        }
    }

    const Voice = {
        supported() { return !!(navigator.mediaDevices && window.MediaRecorder); },

        /* ---------- recording ---------- */
        async start(levelHost, timeEl, opts) {
            if (!Voice.supported()) throw new Error('مرورگر از ضبط صدا پشتیبانی نمی‌کند');
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
            });
            const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', '']
                .find(t => !t || (window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)));
            const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
            const chunks = [];
            mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const src = ctx.createMediaStreamSource(stream);
            const an = ctx.createAnalyser();
            an.fftSize = 64;
            src.connect(an);
            const data = new Uint8Array(an.frequencyBinCount);
            if (levelHost) bars(levelHost, 22);
            const cells = levelHost ? UI.qa('i', levelHost) : [];

            let raf = 0;
            const draw = () => {
                an.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                cells.forEach((c, i) => {
                    const v = data[i % data.length] / 255;
                    c.style.height = Math.max(12, v * 100) + '%';
                });
                if (timeEl) timeEl.textContent = UI.mmss(Date.now() - rec.started);
                raf = requestAnimationFrame(draw);
            };

            rec = {
                mr, stream, chunks, ctx, raf,
                started: Date.now(),
                mime: mime || 'audio/webm',
            };
            mr.start();
            draw();
            return rec;
        },

        get recording() { return !!rec; },

        cancel() {
            if (!rec) return null;
            const r = rec; rec = null;
            cancelAnimationFrame(r.raf);
            return new Promise((resolve) => {
                r.mr.onstop = () => { r.stream.getTracks().forEach(t => t.stop()); try { r.ctx.close(); } catch (e) {} resolve(null); };
                try { r.mr.stop(); } catch (e) { resolve(null); }
            });
        },

        stop() {
            if (!rec) return Promise.resolve(null);
            const r = rec; rec = null;
            cancelAnimationFrame(r.raf);
            const ms = Date.now() - r.started;
            return new Promise((resolve) => {
                r.mr.onstop = async () => {
                    r.stream.getTracks().forEach(t => t.stop());
                    try { r.ctx.close(); } catch (e) {}
                    const blob = new Blob(r.chunks, { type: r.mime });
                    resolve({ blob, duration_ms: ms, mime: r.mime, name: 'voice-' + Date.now() + '.webm' });
                };
                try { r.mr.stop(); } catch (e) { resolve(null); }
            });
        },

        /* ---------- playback ---------- */
        bind(node, waveEl, durEl, urlProvider) {
            const btn = UI.q('.play', node);
            if (!btn) return;
            if (!waveEl) { waveEl = UI.q('.wave', node); }
            const n = 26;
            if (waveEl && !waveEl.childElementCount) bars(waveEl, n);
            const cells = waveEl ? UI.qa('i', waveEl) : [];

            waveEl && waveEl.addEventListener('click', (e) => {
                const a = live && live.audio;
                if (!a || !a.duration) return;
                const r = waveEl.getBoundingClientRect();
                const ratio = 1 - ((e.clientX - r.left) / r.width);
                a.currentTime = Math.max(0, Math.min(1, ratio)) * a.duration;
            });

            btn.addEventListener('click', async () => {
                if (live && live.key === btn) {
                    stopLive();
                    return;
                }
                stopLive();
                let url;
                try { url = await urlProvider(); }
                catch (e) { UI.toast('پخش صوت انجام نشد', 'err'); return; }
                const audio = new Audio(url);
                live = { audio, btn, wave: waveEl, key: btn };
                btn.innerHTML = '<svg class="icon"><use href="#i-pause"/></svg>';
                if (durEl && durEl.dataset.ms) durEl.dataset.full = durEl.dataset.ms;
                audio.addEventListener('timeupdate', () => {
                    if (!audio.duration) return;
                    const p = audio.currentTime / audio.duration;
                    const upto = Math.round(p * cells.length);
                    cells.forEach((c, i) => c.classList.toggle('done', i < upto));
                    if (durEl) durEl.textContent = UI.mmss((audio.duration - audio.currentTime) * 1000);
                });
                audio.addEventListener('ended', () => {
                    if (durEl && durEl.dataset.full) durEl.textContent = UI.mmss(durEl.dataset.full * 1000);
                    stopLive();
                });
                audio.play().catch(() => { stopLive(); UI.toast('پخش متوقف شد', 'err'); });
            });
        },

        stopAll: stopLive,
        isPlaying(btn) { return !!(live && live.key === btn && !live.audio.paused); },

        /* fake equalizer markup for a bubble */
        eqHTML() { return '<span class="eq"><i></i><i></i><i></i></span>'; },
    };

    document.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.voice')) return;
        stopLive();
    }, true);

    window.Voice = Voice;
})();
