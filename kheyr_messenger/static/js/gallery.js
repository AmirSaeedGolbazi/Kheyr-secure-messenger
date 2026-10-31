/* ============================================================
   Gallery — full-screen image/video viewer with swipe + zoom
   ============================================================ */
(function () {
    'use strict';

    let host = null, items = [], idx = 0, scale = 1, pan = { x: 0, y: 0 };
    let startX = 0, startY = 0, dragging = false, pinchDist = 0;

    function shell() {
        if (host) return host;
        host = document.createElement('div');
        host.className = 'lightbox';
        host.innerHTML =
            '<div class="lb-top">' +
            '  <button class="lb-btn" data-lb="close" aria-label="بستن"><svg class="icon"><use href="#i-x"/></svg></button>' +
            '  <div class="grow" style="flex:1"></div>' +
            '  <span class="lb-counter" data-lb="counter"></span>' +
            '  <div style="flex:1"></div>' +
            '  <button class="lb-btn" data-lb="save" aria-label="دانلود"><svg class="icon"><use href="#i-download"/></svg></button>' +
            '</div>' +
            '<div class="lb-stage" data-lb="stage"></div>' +
            '<div class="lb-nav">' +
            '  <button class="lb-btn" data-lb="prev" aria-label="قبلی"><svg class="icon"><use href="#i-arrow-right"/></svg></button>' +
            '  <button class="lb-btn" data-lb="next" aria-label="بعدی"><svg class="icon flip"><use href="#i-arrow-right"/></svg></button>' +
            '</div>';
        (document.getElementById('lightbox-host') || document.body).appendChild(host);

        host.addEventListener('click', (e) => {
            const b = e.target.closest('[data-lb]');
            if (!b) return;
            const a = b.dataset.lb;
            if (a === 'close') Gallery.close();
            if (a === 'prev') Gallery.go(idx - 1);
            if (a === 'next') Gallery.go(idx + 1);
            if (a === 'save') save();
        });
        document.addEventListener('keydown', (e) => {
            if (!host || !host.classList.contains('show')) return;
            if (e.key === 'Escape') Gallery.close();
            if (e.key === 'ArrowLeft') Gallery.go(idx + 1);
            if (e.key === 'ArrowRight') Gallery.go(idx - 1);
        });
        const stage = host.querySelector('[data-lb="stage"]');
        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            scale = Math.min(4, Math.max(1, scale + (e.deltaY < 0 ? .2 : -.2)));
            if (scale === 1) pan = { x: 0, y: 0 };
            applyTransform();
        }, { passive: false });
        stage.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) pinchDist = dist(e.touches);
            else { startX = e.touches[0].clientX; startY = e.touches[0].clientY; dragging = scale > 1; }
        }, { passive: true });
        stage.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const d = dist(e.touches);
                if (pinchDist) scale = Math.min(4, Math.max(1, scale * (d / pinchDist)));
                pinchDist = d; applyTransform();
            } else if (dragging && e.touches.length === 1) {
                pan.x += e.touches[0].clientX - startX; pan.y += e.touches[0].clientY - startY;
                startX = e.touches[0].clientX; startY = e.touches[0].clientY;
                applyTransform();
            }
        }, { passive: false });
        stage.addEventListener('touchend', (e) => {
            pinchDist = 0;
            if (e.changedTouches && e.changedTouches.length === 1 && scale === 1 && !dragging) {
                const dx = e.changedTouches[0].clientX - startX;
                if (Math.abs(dx) > 60) Gallery.go(idx + (dx > 0 ? -1 : 1));
            }
            dragging = false;
        });
        stage.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2.2; applyTransform(); });
        return host;
    }

    function dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    function applyTransform() {
        const el = host && host.querySelector('[data-lb="stage"] > *');
        if (el) el.style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + scale + ')';
    }

    function save() {
        const it = items[idx];
        if (!it) return;
        const a = document.createElement('a');
        a.href = it.url; a.download = it.name || ('media-' + (idx + 1));
        document.body.appendChild(a); a.click(); a.remove();
    }

    function paint() {
        const stage = host.querySelector('[data-lb="stage"]');
        stage.innerHTML = '';
        scale = 1; pan = { x: 0, y: 0 };
        const it = items[idx];
        if (!it) return;
        let el;
        if (it.type === 'video') {
            el = document.createElement('video');
            el.src = it.url; el.controls = true; el.autoplay = true; el.playsInline = true;
        } else {
            el = document.createElement('img');
            el.src = it.url; el.alt = it.name || ''; el.draggable = false;
        }
        stage.appendChild(el);
        host.querySelector('[data-lb="counter"]').textContent =
            (UI.fa(idx + 1) + ' / ' + UI.fa(items.length));
    }

    const Gallery = {
        open(list, start) {
            items = (list || []).filter(Boolean);
            if (!items.length) return;
            idx = Math.max(0, Math.min(items.length - 1, start || 0));
            shell();
            host.classList.add('show');
            document.body.style.overflow = 'hidden';
            paint();
        },
        go(n) {
            if (!items.length) return;
            idx = Math.max(0, Math.min(items.length - 1, n));
            paint();
        },
        close() {
            if (!host) return;
            const v = host.querySelector('video');
            if (v) { try { v.pause(); } catch (e) {} }
            host.classList.remove('show');
            document.body.style.overflow = '';
        },
        get openState() { return !!(host && host.classList.contains('show')); },
    };

    window.Gallery = Gallery;
})();
