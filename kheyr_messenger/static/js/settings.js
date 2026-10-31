/* ============================================================
   Settings page controller
   ============================================================ */
(function () {
    'use strict';

    const BOOL = ['glass', 'animations', 'enter_to_send', 'show_previews', 'show_timestamps', 'sounds', 'push_on'];

    function syncUI(s) {
        UI.qa('[data-setting]').forEach(node => {
            const key = node.dataset.setting;
            const val = s[key];
            if (val === undefined) return;
            if (node.classList.contains('segmented')) {
                UI.qa('button', node).forEach(b =>
                    b.classList.toggle('active', String(b.dataset.v) === String(val)));
            } else if (node.classList.contains('swatches')) {
                UI.qa('.swatch', node).forEach(b =>
                    b.classList.toggle('sel', String(b.dataset.v).toLowerCase() === String(val).toLowerCase()));
            } else if (node.classList.contains('wall-grid')) {
                UI.qa('.wall-tile', node).forEach(b =>
                    b.classList.toggle('sel', b.dataset.v === val));
            } else if (node.type === 'checkbox') {
                node.checked = !!val;
            } else if (node.type === 'range') {
                node.value = val;
                fill(node);
            }
        });
        const bl = UI.q('#blur-val-label');
        if (bl) bl.textContent = UI.fa(s.blur_strength == null ? 18 : s.blur_strength) + 'px';
        const fs = UI.q('#fs-val-label');
        if (fs) fs.textContent = UI.fa(s.font_scale == null ? 100 : s.font_scale) + '٪';
        const cg = UI.q('#chip-glass-ref');
        if (cg) cg.textContent = s.glass === false ? 'خاموش' : 'روشن';
        const cw = UI.q('#chip-wall-ref');
        if (cw) cw.textContent = ({ mesh: 'مش', aurora: 'شفق', dunes: 'تپه', plain: 'ساده' })[s.wallpaper] || '—';
    }

    function fill(range) {
        const min = +range.min || 0, max = +range.max || 100;
        const pct = ((+range.value - min) / (max - min)) * 100;
        range.style.setProperty('--fill', pct + '%');
    }

    async function setPref(key, value) {
        const patch = {}; patch[key] = value;
        UI.applyPrefs(patch);
        const res = await UI.postJSON('/accounts/api/settings/', patch);
        if (res.json && res.json.rejected && res.json.rejected.length) {
            UI.toast('این مقدار پذیرفته نشد', 'err');
        } else if (res.json && res.json.theme) {
            UI.applyPrefs(res.json);
            syncUI(res.json);
            UI.toast('ذخیره شد', 'ok', 1400);
        }
    }

    function wireControls() {
        document.addEventListener('click', (e) => {
            const seg = e.target.closest('.segmented[data-setting] button[data-v]');
            if (seg) {
                const key = seg.closest('[data-setting]').dataset.setting;
                let v = seg.dataset.v;
                if (/^\d+$/.test(v)) v = parseInt(v, 10);
                setPref(key, v);
                return;
            }
            const sw = e.target.closest('.swatches[data-setting] .swatch');
            if (sw) { setPref('accent', sw.dataset.v); return; }
            const wall = e.target.closest('.wall-grid[data-setting] .wall-tile');
            if (wall) { setPref('wallpaper', wall.dataset.v); }
        });

        UI.qa('input[type=checkbox][data-setting]').forEach(inp => {
            inp.addEventListener('change', () => setPref(inp.dataset.setting, inp.checked));
        });

        UI.qa('input[type=range][data-setting]').forEach(inp => {
            fill(inp);
            inp.addEventListener('input', () => { fill(inp); syncUI(Object.assign({}, UI.prefs, { [inp.dataset.setting]: +inp.value })); });
            inp.addEventListener('change', () => setPref(inp.dataset.setting, +inp.value));
        });

        UI.qa('.settings-nav button[data-panel]').forEach(btn => {
            btn.addEventListener('click', () => {
                UI.qa('.settings-nav button').forEach(b => b.classList.remove('active'));
                UI.qa('.settings-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                const p = UI.q('.settings-panel[data-panel="' + btn.dataset.panel + '"]');
                if (p) p.classList.add('active');
            });
        });
    }

    async function pushStatus() {
        const el = UI.q('#push-status');
        if (!el) return;
        try {
            const st = await UI.sw.status();
            el.textContent = !st.sw ? 'service worker فعال نیست'
                : st.permission === 'denied' ? 'مرورگر اجازه‌ی اعلان را رد کرده'
                : st.subscribed ? 'مشترک هستید ✓'
                : 'آماده‌ی فعال‌سازی';
        } catch (e) { el.textContent = 'نامشخص'; }
    }

    function wirePush() {
        const enable = UI.q('#btn-enable-push');
        if (enable) enable.addEventListener('click', async () => {
            enable.disabled = true;
            try {
                await UI.sw.enable();
                await setPref('push_on', true);
                const inp = UI.q('input[data-setting="push_on"]');
                if (inp) inp.checked = true;
                UI.toast('اعلان‌ها فعال شد', 'ok');
            } catch (e) { UI.toast(e.message || 'خطا', 'err'); }
            enable.disabled = false;
            pushStatus();
        });

        const disable = UI.q('#btn-disable-push');
        if (disable) disable.addEventListener('click', async () => {
            await UI.sw.disable();
            await setPref('push_on', false);
            const inp = UI.q('input[data-setting="push_on"]');
            if (inp) inp.checked = false;
            UI.toast('اشتراک لغو شد', 'info');
            pushStatus();
        });

        const test = UI.q('#btn-test-push');
        if (test) test.addEventListener('click', async () => {
            if (typeof Notification === 'undefined') return UI.toast('پشتیبانی نیست', 'err');
            if (Notification.permission !== 'granted') return UI.toast('اول اعلان را فعال کنید', 'err');
            const reg = await UI.sw.reg();
            if (reg) reg.showNotification('پیام‌رسان خیر', {
                body: 'این یک اعلان آزمایشی است.', icon: '/static/icons/icon-192.png', badge: '/static/icons/icon-192.png',
            });
            else new Notification('پیام‌رسان خیر', { body: 'اعلان آزمایشی' });
        });

        const saver = UI.q('#btn-power-saver');
        if (saver) saver.addEventListener('click', async () => {
            await UI.postJSON('/accounts/api/settings/', { animations: false, glass: false, wallpaper: 'plain' });
            UI.applyPrefs({ animations: false, glass: false, wallpaper: 'plain' });
            syncUI(UI.prefs);
            UI.toast('حالت کم‌مصرف اعمال شد', 'ok');
        });

        const keyBtn = UI.q('#btn-show-my-key');
        if (keyBtn) keyBtn.addEventListener('click', async () => {
            const box = UI.q('#my-key-box'), ta = UI.q('#my-key-text');
            if (box.style.display === 'block') { box.style.display = 'none'; return; }
            box.style.display = 'block';
            ta.value = '…';
            try {
                const d = await UI.getJSON('/accounts/api/my-keys/');
                ta.value = d.public_key || '(ثبت نشده)';
                ta.select();
            } catch (e) { ta.value = 'خطا در دریافت کلید'; }
        });

        const refresh = UI.q('#btn-refresh-app');
        if (refresh) refresh.addEventListener('click', async () => {
            refresh.disabled = true;
            await UI.sw.unregisterAll();
            UI.toast('کش پاک شد، در حال بارگذاری…', 'info');
            setTimeout(() => location.reload(), 600);
        });
    }

    /* ---------- profile photos ---------- */
    function updateAvatar(photos) {
        const box = UI.q('#account-avatar');
        if (!box) return;
        const active = photos.find(p => p.active);
        box.innerHTML = '';
        if (active) {
            const img = document.createElement('img');
            img.src = active.url;
            img.alt = '';
            box.appendChild(img);
        } else {
            box.textContent = box.dataset.initial || '';
        }
    }

    function renderPhotos(photos) {
        const grid = UI.q('#profile-photos');
        if (!grid) return;
        const add = UI.q('#btn-add-photo');
        UI.qa('.photo-tile', grid).forEach(n => n.remove());
        photos.forEach(p => {
            const fig = document.createElement('figure');
            fig.className = 'photo-tile' + (p.active ? ' active' : '');
            fig.dataset.id = p.id;
            fig.tabIndex = 0;
            const img = document.createElement('img');
            img.src = p.url;
            img.alt = 'عکس پروفایل';
            img.loading = 'lazy';
            fig.appendChild(img);
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'photo-del';
            del.dataset.del = p.id;
            del.setAttribute('aria-label', 'حذف عکس');
            del.innerHTML = UI.icon('trash');
            fig.appendChild(del);
            if (p.active) {
                const cap = document.createElement('figcaption');
                cap.innerHTML = UI.icon('check');
                fig.appendChild(cap);
            }
            grid.insertBefore(fig, add);
        });
        updateAvatar(photos);
    }

    async function photoPost(url) {
        const res = await fetch(url, {
            method: 'POST', headers: { 'X-CSRFToken': UI.csrf() }, credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('failed');
        return res.json();
    }

    /* a phone photo is many megabytes; the browser shrinks it before it leaves */
    async function shrinkPhoto(file) {
        try {
            const bmp = await createImageBitmap(file);
            const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bmp.width * scale);
            canvas.height = Math.round(bmp.height * scale);
            canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .88));
            if (blob) return new File([blob], 'profile.jpg', { type: 'image/jpeg' });
        } catch (e) { /* unsupported decode path: upload as-is, the server caps size */ }
        return file;
    }

    async function uploadPhotos(files) {
        const add = UI.q('#btn-add-photo');
        if (add) add.disabled = true;
        try {
            for (const f of files) {
                const body = new FormData();
                body.append('image', await shrinkPhoto(f));
                const res = await fetch('/accounts/api/profile-photos/', {
                    method: 'POST', headers: { 'X-CSRFToken': UI.csrf() },
                    body, credentials: 'same-origin',
                });
                if (!res.ok) throw new Error('upload');
                renderPhotos((await res.json()).photos);
            }
            UI.toast('عکس پروفایل ذخیره شد', 'ok');
        } catch (e) {
            UI.toast('بارگذاری عکس ناموفق بود', 'err');
        } finally {
            if (add) add.disabled = false;
        }
    }

    function wirePhotos() {
        const grid = UI.q('#profile-photos');
        const input = UI.q('#photo-input');
        const add = UI.q('#btn-add-photo');
        if (!grid || !input) return;
        if (add) add.addEventListener('click', () => input.click());
        input.addEventListener('change', async () => {
            const files = Array.from(input.files || []);
            input.value = '';
            if (files.length) await uploadPhotos(files);
        });
        grid.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del]');
            try {
                if (del) {
                    if (!window.confirm('این عکس حذف شود؟')) return;
                    renderPhotos((await photoPost(
                        `/accounts/api/profile-photos/${del.dataset.del}/delete/`)).photos);
                    return;
                }
                const tile = e.target.closest('.photo-tile');
                if (!tile) return;
                renderPhotos((await photoPost(
                    `/accounts/api/profile-photos/${tile.dataset.id}/active/`)).photos);
            } catch (err) { UI.toast('انجام نشد', 'err'); }
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tile = e.target.closest('.photo-tile');
            if (!tile) return;
            e.preventDefault();
            tile.click();
        });
    }

    async function boot() {
        const node = UI.q('#settings-data');
        if (!node) return;
        let initial = {};
        try { initial = JSON.parse(node.textContent); } catch (e) {}
        UI.applyPrefs(initial);
        syncUI(Object.assign({}, UI.prefs, initial));
        wireControls();
        wirePush();
        wirePhotos();
        pushStatus();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
