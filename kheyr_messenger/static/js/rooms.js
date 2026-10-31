/* ============================================================
   Rooms list — live previews, unread badges, filters, search
   ============================================================ */
(function () {
    'use strict';

    const KIND_LABEL = {
        image: 'عکس', video: 'ویدیو', voice: 'پیام صوتی', audio: 'موسیقی',
        file: 'فایل', poll: 'نظرسنجی', deleted: 'پیام حذف شد',
    };

    let rows = [];
    let summary = null;
    let keyPair = null;
    let filter = 'all';
    let query = '';

    function rowEl(a) { return a.closest('.chat-row'); }

    function matches(r) {
        const name = (r.dataset.name || '').toLowerCase();
        if (query && !name.includes(query)) return false;
        if (filter === 'unread') return r._unread > 0 && !r._archived;
        if (filter === 'group') return r.dataset.kind === 'group';
        if (filter === 'private') return r.dataset.kind === 'private';
        if (filter === 'archived') return !!r._archived;
        return !r._archived;
    }

    function paint(r) {
        const holder = r.closest('li') || r;
        const hide = !matches(r);
        holder.style.display = hide ? 'none' : '';
        if (hide) return;

        const list = UI.q('.end', r);
        if (!list) return;
        const badges = UI.q('.badges', list);
        const time = UI.q('.time', list);

        let chips = '';
        if (r._muted) chips += UI.icon('bell-off');
        if (r._pinned) chips += UI.icon('pin');
        badges.innerHTML = chips;

        time.textContent = r._ts ? UI.ago(r._ts) : '';
        const prev = UI.q('.prev', r);
        let b = UI.q('.unread', prev);
        if (r._unread > 0) {
            if (!b) {
                b = document.createElement('span');
                b.className = 'badge unread';
                b.style.marginInlineStart = '6px';
                prev.appendChild(b);
            }
            b.textContent = UI.fa(r._unread);
        } else if (b) b.remove();
    }

    /* ---------- per-conversation actions (right-click / long-press) ---------- */
    let pressTimer = null, pressHeld = false, pressFrom = null;

    function closeRoomMenu() {
        const m = UI.q('#room-menu');
        if (m) m.classList.remove('show');
    }

    function openRoomMenu(r, x, y) {
        const menu = UI.q('#room-menu');
        if (!menu) return;
        const name = UI.q('.name', r);
        const items = [
            ['pin', r._pinned ? 'برداشتن پین از بالای لیست' : 'پین در بالای لیست', 'pin'],
            ['mute', r._muted ? 'لغو بی‌صدا' : 'بی‌صدا کردن', r._muted ? 'bell' : 'bell-off'],
            ['archive', r._archived ? 'خروج از بایگانی' : 'بایگانی کردن', 'archive'],
        ];
        if (r._unread > 0) items.push(['read', 'علامت‌گذاری به‌عنوان خوانده‌شده', 'check']);

        menu.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'ctx-head';
        head.textContent = name ? name.textContent.trim() : '';
        menu.appendChild(head);
        items.forEach(([act, label, ic]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.a = act;
            b.innerHTML = UI.icon(ic);
            const span = document.createElement('span');
            span.textContent = label;
            b.appendChild(span);
            menu.appendChild(b);
        });

        const pad = 10;
        const w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.max(pad, Math.min(window.innerWidth - w - pad, x)) + 'px';
        menu.style.top = Math.max(pad, Math.min(window.innerHeight - h - pad, y)) + 'px';
        menu.classList.add('show');

        menu.onclick = async (e) => {
            const b = e.target.closest('button[data-a]');
            if (!b) return;
            closeRoomMenu();
            const id = r.dataset.roomId;
            try {
                if (b.dataset.a === 'read') {
                    const res = await UI.postJSON(`/api/room/${id}/read/`, {});
                    if (res.status !== 200) throw new Error('read');
                } else {
                    const patch = {};
                    if (b.dataset.a === 'pin') patch.pinned = !r._pinned;
                    if (b.dataset.a === 'mute') patch.muted = !r._muted;
                    if (b.dataset.a === 'archive') patch.archived = !r._archived;
                    const res = await UI.postJSON(`/api/room/${id}/prefs/`, patch);
                    if (res.status !== 200) throw new Error('prefs');
                }
                await load();
            } catch (err) { UI.toast('اعمال نشد', 'err'); }
        };
    }

    function wireRowMenu(r) {
        r.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            pressHeld = false;
            clearTimeout(pressTimer);
            openRoomMenu(r, e.clientX, e.clientY);
        });
        r.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            pressHeld = false;
            pressFrom = { x: e.clientX, y: e.clientY };
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                pressHeld = true;
                openRoomMenu(r, e.clientX, e.clientY);
                if (navigator.vibrate) navigator.vibrate(12);
            }, 480);
        });
        const cancel = () => { clearTimeout(pressTimer); pressFrom = null; };
        r.addEventListener('pointerup', cancel);
        r.addEventListener('pointercancel', cancel);
        r.addEventListener('pointerleave', cancel);
        r.addEventListener('pointermove', (e) => {
            if (!pressFrom) return;
            if (Math.abs(e.clientX - pressFrom.x) > 10 || Math.abs(e.clientY - pressFrom.y) > 10) cancel();
        });
        /* the press that opened the menu must not also open the chat */
        r.addEventListener('click', (e) => {
            if (!pressHeld) return;
            pressHeld = false;
            e.preventDefault();
            e.stopPropagation();
        });
    }

    async function decryptPreview(last) {
        if (!last) return { text: 'هنوز پیامی نیست', mine: false };
        const mine = Number(last.sender_id) === Number(window.APP.me.id);
        const who = mine ? 'شما: ' : (last.sender_username + ': ');
        if (last.kind === 'deleted') return { text: 'پیام حذف‌شده', mine };
        if (KIND_LABEL[last.kind] && last.kind !== 'text') {
            if (last.file_name && last.kind === 'file') return { text: '📎 ' + last.file_name, mine };
            return { text: KIND_LABEL[last.kind], mine };
        }
        try {
            let plain = await CryptoHelpers.decryptMessage(last, keyPair, window.APP.me.id);
            const p = Polls.parse(plain);
            if (p && p.t === 'poll') plain = p.q;
            if (p && p.t === 'vote') return { text: 'رأی به گزینه ' + UI.fa((p.v || 0) + 1), mine };
            plain = String(plain).replace(/\s+/g, ' ').trim();
            return { text: who + (plain.slice(0, 70) || KIND_LABEL[last.kind] || ''), mine };
        } catch (e) {
            return { text: '🔒 پیام رمزنگاری‌شده', mine };
        }
    }

    async function hydratePreviews() {
        if (!UI.prefs.show_previews) {
            rows.forEach(r => {
                const p = UI.q('.prev', r);
                if (p) { p.classList.remove('loading'); p.textContent = 'پیام جدید'; }
            });
            return;
        }
        for (const r of rows) {
            const p = UI.q('.prev', r);
            if (!p || !r._last) { if (p) { p.classList.remove('loading'); p.textContent = '—'; } continue; }
            const { text } = await decryptPreview(r._last);
            p.classList.remove('loading');
            p.textContent = text;
        }
    }

    async function load() {
        let data;
        try { data = await UI.getJSON('/api/rooms/summary/'); }
        catch (e) { UI.toast('لیست گفتگوها بارگذاری نشد', 'err'); return; }
        summary = {};
        rows.forEach(r => { r._last = null; r._unread = 0; r._muted = false; r._pinned = false; r._archived = false; r._ts = ''; });

        (data.rooms || []).forEach(room => {
            const link = UI.q('.chat-row[data-room-id="' + room.id + '"]');
            summary[room.id] = room;
            if (!link) return;
            const r = rowEl(link);
            r._unread = room.unread; r._muted = room.muted; r._pinned = room.pinned;
            r._archived = room.archived; r._last = room.last;
            r._ts = room.last ? room.last.timestamp : '';
            paint(r);
        });

        const list = UI.q('#rooms-list');
        if (list) {
            rows.forEach(r => {
                const li = r.closest('li');
                if (li) { li._row = r; if (!li.isConnected) list.appendChild(li); }
            });
            const items = rows.map(r => r.closest('li')).filter(Boolean);
            const rank = (r) => (r._pinned ? 0 : r._archived ? 2 : 1);
            const lastId = (r) => (r._last ? r._last.id : 0);
            items.sort((a, b) => (rank(a._row) - rank(b._row)) || (lastId(b._row) - lastId(a._row)));
            items.forEach(li => list.appendChild(li));
        }
        await hydratePreviews();
        rows.forEach(paint);
    }

    function wireCreateCard() {
        const ov = UI.q('#create-group-overlay');
        const open = UI.q('#btn-open-create');
        const close = UI.q('#btn-close-create');
        const cancel = UI.q('#btn-cancel-create');
        if (!ov) return;
        const show = () => {
            ov.classList.add('show');
            setTimeout(() => {
                const name = UI.q('#id_name');
                if (name) name.focus();
            }, 80);
        };
        const hide = () => ov.classList.remove('show');
        if (open) open.addEventListener('click', show);
        if (close) close.addEventListener('click', hide);
        if (cancel) cancel.addEventListener('click', hide);
        ov.addEventListener('click', (e) => { if (e.target === ov) hide(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && ov.classList.contains('show')) hide();
        });
    }

    function wire() {
        const search = UI.q('#rooms-search');
        if (search) search.addEventListener('input', () => {
            query = search.value.trim().toLowerCase();
            rows.forEach(paint);
        });

        const seg = UI.q('#rooms-filter');
        if (seg) seg.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-f]');
            if (!b) return;
            UI.qa('button', seg).forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            filter = b.dataset.f;
            rows.forEach(paint);
        });

        const swatches = UI.q('#avatar-swatches');
        if (swatches) swatches.addEventListener('click', (e) => {
            const s = e.target.closest('.swatch');
            if (!s) return;
            UI.qa('.swatch', swatches).forEach(x => x.classList.remove('sel'));
            s.classList.add('sel');
            const inp = UI.q('#avatar-color-input');
            if (inp) inp.value = s.dataset.c;
        });

        const pick = UI.q('#member-pick');
        const members = UI.q('#members-input');
        if (pick && members) pick.addEventListener('click', (e) => {
            const c = e.target.closest('.chip');
            if (!c) return;
            c.classList.toggle('sel');
            members.value = UI.qa('.chip.sel', pick).map(x => x.dataset.id).join(',');
        });

        const form = UI.q('#create-group-form');
        if (form) form.addEventListener('submit', (e) => {
            if (!UI.q('#members-input').value) {
                e.preventDefault();
                UI.toast('حداقل یک عضو را انتخاب کنید', 'err');
            }
        });

        rows.forEach(wireRowMenu);
        document.addEventListener('click', (e) => {
            const menu = UI.q('#room-menu');
            if (menu && menu.classList.contains('show') && !e.target.closest('#room-menu')) closeRoomMenu();
        });
        window.addEventListener('scroll', closeRoomMenu, { passive: true });

        window.addEventListener('focus', () => { if (summary) load(); });
    }

    async function boot() {
        const list = UI.q('#rooms-list');
        if (!list) return;
        wireCreateCard();
        rows = UI.qa('.chat-row[data-room-id]', list);
        rows.forEach(r => { r._unread = 0; r._muted = false; r._pinned = false; r._archived = false; });
        if (!rows.length) return;

        if (!(await UI.ready)) return;
        try { keyPair = await UI.unlock({ prompt: false }); }
        catch (e) { keyPair = null; }

        wire();
        await load();
        if (!keyPair) {
            rows.forEach(r => {
                const p = UI.q('.prev', r);
                if (p) { p.classList.remove('loading'); p.textContent = '🔒 برای دیدن پیش‌نمایش وارد شوید'; }
            });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
