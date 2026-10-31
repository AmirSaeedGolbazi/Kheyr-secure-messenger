/* ============================================================
   Kheyr chat surface
   — E2EE envelopes are decrypted here only; the server stores
     opaque ciphertext, so previews/polls/reactions live client-side.
   ============================================================ */
(async function () {
    'use strict';

    if (!(await UI.ready)) return;

    const roomNode = UI.q('#room-data');
    if (!roomNode) return;
    const room = JSON.parse(roomNode.textContent);
    if (!room || !room.id) return;

    const me = window.APP.me;
    if (!me.id) return;

    if (!sessionStorage.getItem('chat_username')) { try { await KeyDB.clear(); } catch (e) {} }

    const log = UI.q('#chat-log');
    const input = UI.q('#chat-input');
    const sendBtn = UI.q('#chat-send');
    const composerRow = UI.q('#chat-input-row');
    const prefs = Object.assign({ muted: false, pinned: false, archived: false }, room.prefs || {});

    let keyPair = null;
    let memberKeys = {};
    let ws = null, wsReady = false;
    let hasMore = true, loadingOlder = false, oldestId = null;
    let unseen = 0, typingTimer = null, typingHide = null;
    let replyTo = null;

    const seen = new Set();
    const byId = new Map();          // message id -> payload
    const rowOf = new Map();         // message id -> row element
    const plain = new Map();         // message id -> decrypted text
    const votes = new Map();         // poll id -> [{by, v}]
    const pins = [];                 // pinned message ids, newest first

    /* ------------------------------------------------------------------
       boot: keys, members, history
       ------------------------------------------------------------------ */
    async function unlock(text) {
        keyPair = await UI.unlock({ prompt: true, requiredText: text });
        localStorage.setItem('kheyr_unlocked_at', String(Date.now()));
    }

    try {
        await unlock();
    } catch (e) {
        UI.toast('برای رمزگشایی، رمز اصلی لازم است', 'err');
        try { await unlock(); } catch (e2) { return; }
    }

    try {
        const mk = await UI.getJSON(`/api/room/${room.id}/members-public-keys/`);
        memberKeys = {};
        for (const [uid, pub] of Object.entries(mk.keys || {})) { if (pub) memberKeys[uid] = pub; }
    } catch (e) { UI.toast('کلیدهای اعضا دریافت نشد', 'err'); }

    /* ------------------------------------------------------------------
       wipe epoch (duress) polling
       ------------------------------------------------------------------ */
    let knownEpoch = null;
    async function checkEpoch() {
        try {
            const d = await UI.getJSON('/accounts/api/wipe-status/');
            if (knownEpoch === null) { knownEpoch = d.epoch; return false; }
            if (d.epoch !== knownEpoch) {
                await UI.lock();
                location.href = '/accounts/login/?wiped=1';
                return true;
            }
        } catch (e) {}
        return false;
    }
    await checkEpoch();
    setInterval(checkEpoch, 12000);

    /* ------------------------------------------------------------------
       auto lock
       ------------------------------------------------------------------ */
    const lockMinutes = UI.prefs.auto_lock_minutes == null ? 10 : UI.prefs.auto_lock_minutes;
    let lockTimer = null;
    function armLock() {
        if (!lockMinutes) return;
        clearTimeout(lockTimer);
        lockTimer = setTimeout(async () => {
            await UI.lock();
            UI.toast('به دلیل بی‌فعالیتی قفل شد', 'info');
            try { await unlock('برای ادامه، رمز اصلی را وارد کنید.'); scheduleRender(); }
            catch (e) { location.reload(); }
        }, lockMinutes * 60 * 1000);
    }
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(ev =>
        document.addEventListener(ev, () => localStorage.setItem('kheyr_unlocked_at', String(Date.now())), { passive: true }));
    armLock();

    /* ------------------------------------------------------------------
       websocket
       ------------------------------------------------------------------ */
    function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}/ws/chat/${room.id}/`);
        ws.onopen = () => { wsReady = true; };
        ws.onclose = () => { wsReady = false; setTimeout(connect, 2200); };
        ws.onmessage = (e) => {
            let d; try { d = JSON.parse(e.data); } catch (err) { return; }
            if (d.type === 'chat_message') onIncoming(d);
            else if (d.type === 'message_update') onIncoming(d);
            else if (d.type === 'typing') showTyping(d.from_username);
            else if (d.type === 'call_group_invite') handleCallInvite(d);
        };
    }

    async function onIncoming(d) {
        if (d.type === 'message_update') {
            byId.set(d.id, d);
            if (d.kind === 'poll_vote') harvestVotes(d);
            if (d.pinned_at) { removePin(d.id); if (!d.deleted_at) pins.unshift(d.id); }
            else removePin(d.id);
            scheduleRender();
            refreshPinBar();
            return;
        }
        const known = byId.has(d.id);
        byId.set(d.id, d);
        if (d.kind === 'poll_vote') {
            harvestVotes(d);
            await decryptText(d);
            scheduleRender();
            return;
        }
        if (d.pinned_at && pins.indexOf(d.id) < 0) { pins.unshift(d.id); refreshPinBar(); }
        if (known) { scheduleRender(); return; }
        scheduleRender();
        if (d.sender_id !== me.id) {
            const atBottom = nearBottom();
            if (!atBottom) { unseen++; paintJump(); }
            if (document.hidden || !atBottom) notify(d);
            if (UI.prefs.sounds !== false && !document.hidden) UI.ping('recv');
        }
        if (atBottomNow()) markRead();
    }

    function atBottomNow() { return nearBottom(); }

    function notify(d) {
        UI.toast(`${room.name}: ${d.sender_username}`, 'info', 4000);
    }

    function harvestVotes(voteMsg) {
        if (!voteMsg.parent) return;
        const pid = voteMsg.parent.id;
        if (!votes.has(pid)) votes.set(pid, []);
        const list = votes.get(pid);
        const i = list.findIndex(x => x.by === voteMsg.sender_id);
        const rec = { by: voteMsg.sender_id, msg: voteMsg.id };
        if (i >= 0) list[i] = Object.assign(list[i] || {}, rec); else list.push(rec);
    }

    /* ------------------------------------------------------------------
       history
       ------------------------------------------------------------------ */
    async function loadInitial() {
        const data = await UI.getJSON(`/api/room/${room.id}/messages/?limit=60`);
        (data.messages || []).forEach(m => {
            byId.set(m.id, m);
            if (m.kind === 'poll_vote') harvestVotes(m);
            if (m.pinned_at) pins.push(m.id);
        });
        hasMore = !!data.has_more;
        const list = (data.messages || []).filter(m => m.kind !== 'poll_vote');
        oldestId = list.length ? list[0].id : null;
        renderAll();
        scrollToEnd(false);
        refreshPinBar();
        markRead();
    }

    async function loadOlder() {
        if (!hasMore || loadingOlder || !oldestId) return;
        loadingOlder = true;
        try {
            const data = await UI.getJSON(`/api/room/${room.id}/messages/?limit=40&before=${oldestId}`);
            const list = (data.messages || []).filter(m => m.kind !== 'poll_vote');
            list.forEach(m => {
                byId.set(m.id, m);
                if (m.pinned_at && pins.indexOf(m.id) < 0) pins.push(m.id);
            });
            if (list.length) oldestId = list[0].id;
            hasMore = !!data.has_more;
            renderAll();
        } finally {
            loadingOlder = false;
        }
    }

    /* ------------------------------------------------------------------
       rendering
       ------------------------------------------------------------------ */
    function avatarFor(m) {
        const a = document.createElement('span');
        a.className = 'avatar sm';
        a.textContent = (m.sender_username || '?').slice(0, 1).toUpperCase();
        return a;
    }

    function daySeparator(iso) {
        const d = document.createElement('div');
        d.className = 'day-sep';
        d.dataset.day = UI.dayKey(iso);
        d.textContent = UI.dayLabel(iso);
        return d;
    }

    function ensureDay(iso) {
        const key = UI.dayKey(iso);
        if (!key) return;
        const last = UI.qa('.day-sep', log).pop();
        if (last && last.dataset.day === key) return;
        log.appendChild(daySeparator(iso));
    }

    function metaRow(m) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        const parts = [];
        if (UI.prefs.show_timestamps !== false) parts.push('<span>' + UI.timeOf(m.timestamp) + '</span>');
        if (m.edited_at || (UI.prefs.show_timestamps === false && false)) parts.push('<span>ویرایش</span>');
        if (m.sender_id === me.id) parts.push(UI.icon('check'));
        meta.innerHTML = parts.join('');
        return meta;
    }

    function reactionsRow(m) {
        const wrap = document.createElement('div');
        wrap.className = 'reactions';
        const entries = Object.entries(m.reactions || {});
        if (!entries.length) return null;
        entries.forEach(([emoji, users]) => {
            const b = document.createElement('button');
            b.type = 'button';
            if (users.includes(me.id)) b.className = 'mine';
            b.innerHTML = `<span>${UI.esc(emoji)}</span><span>${UI.fa(users.length)}</span>`;
            b.addEventListener('click', () => react(m.id, emoji));
            wrap.appendChild(b);
        });
        return wrap;
    }

    function replyQuote(parent) {
        const q = document.createElement('div');
        q.className = 'reply-quote';
        q.innerHTML = '<b></b><span></span>';
        UI.q('b', q).textContent = parent.sender_username;
        const span = UI.q('span', q);
        if (parent.kind === 'deleted') span.textContent = 'پیام حذف شده';
        else if (!parent.content) span.textContent = parent.file_name || 'پیوست';
        else {
            span.textContent = '…';
            decryptText(parent).then(t => { span.textContent = t.slice(0, 80); });
        }
        q.addEventListener('click', () => jumpTo(parent.id));
        return q;
    }

    async function decryptText(m) {
        if (plain.has(m.id)) return plain.get(m.id);
        if (!m.content) return '';
        let t;
        try { t = await CryptoHelpers.decryptMessage(m, keyPair, me.id); }
        catch (e) { t = '[قابل رمزگشایی نیست]'; }
        plain.set(m.id, t);
        return t;
    }

    function captionBlock(m) {
        const txt = document.createElement('div');
        txt.className = 'msg-text caption';
        txt.textContent = '…';
        decryptText(m).then(t => {
            txt.innerHTML = '';
            linkify(t).forEach(node => txt.appendChild(node));
        });
        return txt;
    }

    function fillBubble(b, m) {
        if (m.pinned_at) {
            const flag = document.createElement('div');
            flag.className = 'pin-flag';
            flag.innerHTML = UI.icon('pin') + '<span>پین شده</span>';
            b.appendChild(flag);
        }
        if (m.parent) b.appendChild(replyQuote(m.parent));

        if (m.kind === 'deleted') {
            b.classList.add('deleted');
            const s = document.createElement('div');
            s.textContent = 'این پیام حذف شد';
            b.appendChild(s);
        } else if (m.kind === 'system') {
            const s = document.createElement('div');
            decryptText(m).then(t => { s.textContent = t; });
            b.appendChild(s);
        } else if (m.file_id) {
            b.classList.add('has-media');
            b.appendChild(mediaBody(m));
            if (m.content) b.appendChild(captionBlock(m));
        } else if (m.kind === 'poll') {
            b.appendChild(pollBody(m));
        } else {
            const txt = document.createElement('div');
            txt.className = 'msg-text';
            txt.textContent = '…';
            b.appendChild(txt);
            decryptText(m).then(t => {
                txt.innerHTML = '';
                linkify(t).forEach(node => txt.appendChild(node));
            });
        }

        if (m.sender_id !== me.id && room.is_group && m.kind !== 'deleted') {
            const n = document.createElement('div');
            n.className = 'sender-name';
            n.textContent = m.sender_username;
            b.insertBefore(n, b.firstChild);
        }

        b.appendChild(metaRow(m));
        const r = reactionsRow(m);
        if (r) b.appendChild(r);
        return b;
    }

    function linkify(text) {
        const out = [];
        const re = /(https?:\/\/[^\s]+)/g;
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
            const a = document.createElement('a');
            a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = m[0];
            out.push(a);
            last = m.index + m[0].length;
        }
        if (last < text.length) out.push(document.createTextNode(text.slice(last)));
        if (!out.length) out.push(document.createTextNode(text));
        return out;
    }

    /* ---------- media bodies ---------- */
    function mediaBody(m) {
        const host = document.createElement('div');
        const kind = m.file_kind || m.kind;

        if (kind === 'image') {
            const img = document.createElement('img');
            img.className = 'media-img';
            img.alt = m.file_name || '';
            img.loading = 'lazy';
            host.appendChild(img);
            host.dataset.kind = 'image';
            MediaCache.url(m, keyPair, me.id)
                .then(u => { img.src = u; img.addEventListener('click', () => openGallery(m.id)); })
                .catch(() => { host.innerHTML = ''; host.textContent = '🖼 ' + (m.file_name || 'عکس'); });
            return host;
        }

        if (kind === 'video') {
            const wrap = document.createElement('div');
            wrap.className = 'video-wrap';
            const v = document.createElement('video');
            v.controls = true; v.playsInline = true; v.preload = 'metadata';
            wrap.appendChild(v);
            const dur = document.createElement('span');
            dur.className = 'dur';
            dur.textContent = m.duration_ms ? UI.mmss(m.duration_ms) : '';
            wrap.appendChild(dur);
            host.appendChild(wrap);
            MediaCache.url(m, keyPair, me.id)
                .then(u => { v.src = u; })
                .catch(() => { wrap.textContent = 'ویدیو باز نشد'; });
            return host;
        }

        if (kind === 'voice') {
            const v = document.createElement('div');
            v.className = 'voice';
            v.innerHTML =
                '<button type="button" class="play"><svg class="icon"><use href="#i-play"/></svg></button>' +
                '<span class="wave"></span>' +
                '<span class="dur" data-ms="' + (m.duration_ms || 0) + '">' + (m.duration_ms ? UI.mmss(m.duration_ms) : '') + '</span>';
            host.appendChild(v);
            Voice.bind(v, UI.q('.wave', v), UI.q('.dur', v), () => MediaCache.url(m, keyPair, me.id));
            return host;
        }

        if (kind === 'audio') {
            const card = document.createElement('div');
            card.className = 'music-card';
            card.innerHTML =
                '<div class="art">' + UI.icon('music') + '<img alt="" loading="lazy"></div>' +
                '<div class="mmeta">' +
                '<div class="mt truncate"></div>' +
                '<div class="ma truncate"></div>' +
                '<div class="mal truncate"></div>' +
                '</div>' +
                '<div class="mrow"><span class="mdur"></span>' +
                '<button type="button" class="btn btn-primary btn-sm dl"><svg class="icon"><use href="#i-play"/></svg></button></div>';
            const elTitle = UI.q('.mt', card), elArtist = UI.q('.ma', card),
                elAlbum = UI.q('.mal', card), elArt = UI.q('.art img', card),
                elGlyph = UI.q('.art .icon', card);
            let tags = Tags.peek(m.file_id);
            elTitle.textContent = (m.file_name || 'موسیقی').replace(/\.[a-z0-9]+$/i, '');
            elArtist.textContent = m.sender_username || '';
            elAlbum.style.display = 'none';
            UI.q('.mdur', card).textContent = m.duration_ms ? UI.mmss(m.duration_ms) : '';

            function paintTags(t) {
                if (!t) return;
                tags = t;
                if (t.title) elTitle.textContent = t.title;
                const line = [];
                const who = t.artist || t.albumArtist || m.sender_username || '';
                if (who) line.push(who);
                if (t.track) line.push(UI.fa(t.track) + '.' + (t.disc ? ' / ' + UI.fa(t.disc) + '.' : ''));
                elArtist.textContent = line.join('  •  ');
                const more = [];
                if (t.album) more.push(t.album);
                if (t.year) more.push('(' + t.year + ')');
                if (t.genre) more.push(t.genre);
                elAlbum.textContent = more.join(' — ');
                elAlbum.style.display = more.length ? '' : 'none';
                if (t.cover) {
                    elArt.src = 'data:' + t.cover.mime + ';base64,' + t.cover.data;
                    elArt.classList.add('on');
                    elGlyph.style.display = 'none';
                }
                if (t.duration_ms) UI.q('.mdur', card).textContent = UI.mmss(t.duration_ms);
            }
            if (m.has_meta) Tags.load(m, keyPair, me.id).then(paintTags).catch(() => {});

            const trackFor = (url) => {
                const t = tags || {};
                return {
                    url: url, fileId: m.file_id,
                    title: t.title || elTitle.textContent,
                    artist: t.artist || t.albumArtist || m.sender_username || '',
                    album: t.album || '', year: t.year || '',
                    duration_ms: m.duration_ms || t.duration_ms || 0,
                    artwork: t.cover ? 'data:' + t.cover.mime + ';base64,' + t.cover.data : null,
                };
            };

            host.appendChild(card);
            UI.q('.dl', card).addEventListener('click', async () => {
                const btn = UI.q('.dl', card);
                btn.disabled = true;
                try {
                    const u = await MediaCache.url(m, keyPair, me.id);
                    Player.append(trackFor(u));
                    UI.ping('send');
                } catch (e) { UI.toast('پخش انجام نشد', 'err'); }
                btn.disabled = false;
            });
            return host;
        }

        const card = document.createElement('div');
        card.className = 'file-card';
        card.innerHTML =
            '<span class="glyph">' + UI.icon('file') + '</span>' +
            '<span class="fmeta"><span class="name truncate"></span><span class="size"></span></span>' +
            '<button type="button" class="btn btn-ghost btn-sm dl">' + UI.icon('download') + '</button>';
        UI.q('.name', card).textContent = m.file_name || 'فایل';
        UI.q('.size', card).textContent = UI.bytes(m.size_bytes);
        UI.q('.dl', card).addEventListener('click', async () => {
            const btn = UI.q('.dl', card);
            btn.disabled = true;
            try {
                const u = await MediaCache.url(m, keyPair, me.id);
                const a = document.createElement('a');
                a.href = u; a.download = m.file_name || 'file';
                document.body.appendChild(a); a.click(); a.remove();
            } catch (e) { UI.toast('دانلود ناموفق', 'err'); }
            btn.disabled = false;
        });
        host.appendChild(card);
        return host;
    }

    /* ---------- open in lightbox ---------- */
    async function openGallery(startId) {
        const imgs = [...byId.values()]
            .filter(m => m.file_id && !m.deleted_at && (m.file_kind || m.kind) === 'image')
            .sort((a, b) => a.id - b.id);
        const items = [];
        for (const m of imgs) {
            try {
                const u = await MediaCache.url(m, keyPair, me.id);
                items.push({ url: u, type: 'image', name: m.file_name, id: m.id });
            } catch (e) {}
        }
        Gallery.open(items, Math.max(0, items.findIndex(i => i.id === Number(startId))));
    }

    /* ---------- poll ---------- */
    function pollBody(m) {
        const host = document.createElement('div');
        host.className = 'poll';
        host.innerHTML = '<h4>…</h4>';
        decryptText(m).then(t => {
            const p = Polls.parse(t);
            if (!p) { host.innerHTML = '<h4>نظرسنجی خراب است</h4>'; return; }
            const list = votes.get(m.id) || [];
            const shaped = list.map(v => {
                const vm = byId.get(v.msg);
                return vm ? { by: vm.sender_id, v: pollChoiceIndex(vm) } : null;
            }).filter(x => x && x.v != null);
            Polls.render(host, p, shaped, me.id, (i) => sendVote(m, i));
        });
        return host;
    }

    function pollChoiceIndex(voteMsg) {
        if (plain.has(voteMsg.id)) {
            const p = Polls.parse(plain.get(voteMsg.id));
            return p ? p.v : null;
        }
        return null;
    }

    /* Pre-decrypt vote payloads so tallies can be computed synchronously. */
    async function primeVotes() {
        for (const m of byId.values()) {
            if (m.kind === 'poll_vote' && m.content) await decryptText(m);
        }
    }

    async function sendVote(pollMsg, optionIndex) {
        if (!wsReady) return UI.toast('اتصال برقرار نیست', 'err');
        if (!Object.keys(memberKeys).length) return UI.toast('کلید اعضا نیست', 'err');
        const text = Polls.encodeVote(optionIndex, pollMsg.id);
        try {
            const enc = await CryptoHelpers.encryptForMembers(text, memberKeys);
            ws.send(JSON.stringify({
                type: 'chat_message', kind: 'poll_vote',
                parent_id: pollMsg.id, ...enc,
            }));
        } catch (e) { UI.toast(e.message, 'err'); }
    }

    /* ---------- row assembly (single grouped render pass) ---------- */
    const isImage = (m) => !!m.file_id && !m.deleted_at && (m.file_kind || m.kind) === 'image';

    function groupModel() {
        const list = [...byId.values()].sort((a, b) => a.id - b.id).filter(m => m.kind !== 'poll_vote');
        const out = [];
        for (const m of list) {
            const prev = out[out.length - 1];
            if (isImage(m) && prev && prev.group && prev.sender === m.sender_id
                && prev.group.length < 10
                && (new Date(m.timestamp) - new Date(prev.last.timestamp)) < 120000) {
                prev.group.push(m); prev.last = m;
                continue;
            }
            out.push({ group: isImage(m) ? [m] : null, items: [m], sender: m.sender_id, last: m });
        }
        return out;
    }

    function buildRow(entry) {
        const head = entry.items[0];
        const mine = head.sender_id === me.id;
        const row = document.createElement('div');
        row.className = 'msg-row' + (mine ? ' mine' : '');
        row.dataset.id = head.id;
        row.dataset.sender = head.sender_id;
        if (seen.has(head.id)) row.style.animation = 'none';
        else seen.add(head.id);

        row.appendChild(avatarFor(head));

        const bubble = document.createElement('div');
        bubble.className = 'bubble ' + (mine ? 'out' : 'in');
        bubble.dataset.id = head.id;
        bubble.dataset.kind = head.kind;

        if (entry.group && entry.group.length > 1) {
            bubble.classList.add('has-media');
            const grid = document.createElement('div');
            grid.className = 'gallery-grid' + (entry.group.length >= 3 ? ' n3' : '');
            grid.dataset.count = Math.min(entry.group.length, 4);
            entry.group.slice(0, 4).forEach((m, i) => {
                const cell = document.createElement('div');
                cell.className = 'cell';
                if (i === 0) cell.style.gridColumn = entry.group.length === 3 ? 'span 2' : '';
                const img = document.createElement('img');
                img.alt = m.file_name || '';
                cell.appendChild(img);
                img.addEventListener('click', () => openGallery(m.id));
                grid.appendChild(cell);
                MediaCache.url(m, keyPair, me.id)
                    .then(u => { img.src = u; })
                    .catch(() => { cell.textContent = '🖼'; });
            });
            if (entry.group.length > 4) {
                const more = document.createElement('div');
                more.className = 'more';
                more.textContent = '+' + UI.fa(entry.group.length - 4);
                more.addEventListener('click', () => openGallery(entry.group[4].id));
                grid.appendChild(more);
            }
            bubble.appendChild(grid);
            bubble.appendChild(metaRow(entry.group[entry.group.length - 1]));
            entry.group.forEach(m => rowOf.set(m.id, row));
        } else {
            fillBubble(bubble, head);
            rowOf.set(head.id, row);
        }

        row.appendChild(bubble);
        wireBubbleEvents(row, bubble, head);
        return row;
    }

    let renderQueued = false;
    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; renderAll(); });
    }

    function anchor() {
        const top = log.scrollTop;
        for (const el of log.children) {
            if (el.offsetTop + el.offsetHeight > top) return { id: Number(el.dataset.id || 0), off: el.offsetTop - top };
        }
        return null;
    }

    function renderAll() {
        const keep = nearBottom(240) ? null : anchor();
        log.innerHTML = '';
        rowOf.clear();
        for (const entry of groupModel()) {
            const m = entry.items[0];
            ensureDay(m.timestamp);
            log.appendChild(buildRow(entry));
        }
        if (!keep) { scrollToEnd(false); return; }
        const row = keep.id ? rowOf.get(keep.id) : null;
        if (row) log.scrollTop = row.offsetTop - keep.off;
        paintJump();
    }

    /* ---------- bubble interactions ---------- */
    function wireBubbleEvents(row, bubble, m) {
        let timer = null;
        const open = (x, y) => openMenu(m, x, y);
        bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e.clientX, e.clientY); });
        bubble.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            timer = setTimeout(() => open(t.clientX, t.clientY), 520);
        }, { passive: true });
        ['touchend', 'touchmove', 'scroll'].forEach(ev =>
            bubble.addEventListener(ev, () => clearTimeout(timer), { passive: true }));
        bubble.addEventListener('dblclick', () => setReply(m));
    }

    /* ---------- save-to-Saved-Messages (cross-room copy) ---------- */
    let savedRoomId = null;

    async function savedRoom() {
        if (savedRoomId) return savedRoomId;
        const d = await UI.getJSON('/api/room/saved/');
        savedRoomId = d.id;
        return savedRoomId;
    }

    async function memberKeysOf(roomId) {
        const d = await UI.getJSON('/api/room/' + roomId + '/members-public-keys/');
        const out = {};
        for (const [uid, pub] of Object.entries(d.keys || {})) { if (pub) out[uid] = pub; }
        return out;
    }

    async function saveToSaved(m) {
        try {
            const id = await savedRoom();
            const keys = await memberKeysOf(id);
            if (!Object.keys(keys).length) return UI.toast('کلید عمومی خودتان آماده نیست', 'err');
            if (m.file_id) {
                const blob = await MediaCache.blob(m, keyPair, me.id);
                const file = new File([blob], m.file_name || ('media-' + m.id),
                                      { type: m.mime_type || blob.type || 'application/octet-stream' });
                const enc = await CryptoHelpers.encryptFileForMembers(file, keys);
                const fd = new FormData();
                fd.append('file', enc.blob, 'enc.bin');
                fd.append('iv', enc.iv);
                fd.append('encrypted_keys', JSON.stringify(enc.encrypted_keys));
                fd.append('original_name', file.name);
                fd.append('mime_type', file.type);
                fd.append('kind', m.file_kind || m.kind);
                if (m.duration_ms) fd.append('duration_ms', m.duration_ms);
                if (m.width) fd.append('width', m.width);
                if (m.height) fd.append('height', m.height);
                const res = await fetch('/api/room/' + id + '/upload-file/', {
                    method: 'POST', headers: { 'X-CSRFToken': UI.csrf() },
                    body: fd, credentials: 'same-origin',
                });
                if (!res.ok) throw new Error('upload ' + res.status);
            } else {
                const text = await decryptText(m);
                if (!text || text === '[قابل رمزگشایی نیست]') return UI.toast('متن در دسترس نیست', 'err');
                const enc = await CryptoHelpers.encryptForMembers(text, keys);
                const res = await UI.postJSON('/api/room/' + id + '/send/',
                                              { ...enc, kind: 'text' });
                if (res.status !== 200) throw new Error('send ' + res.status);
            }
            UI.toast('در پیام‌های ذخیره‌شده ذخیره شد', 'ok', 1800);
        } catch (e) { UI.toast('ذخیره نشد', 'err'); }
    }

    const MENU_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

    function openMenu(m, x, y) {
        const menu = UI.q('#msg-menu');
        if (!menu) return;
        const items = [];
        items.push(['reply', 'پاسخ', 'reply']);
        if (m.content && !m.file_id) items.push(['copy', 'کپی متن', 'copy']);
        if (!m.deleted_at && (m.file_id || (m.kind === 'text' && m.content)))
            items.push(['save', 'ذخیره در پیام‌های ذخیره‌شده', 'bookmark']);
        if ((m.file_kind || m.kind) === 'image' || (m.file_kind || m.kind) === 'video')
            items.push(['media', 'باز کردن تمام‌صفحه', 'expand']);
        items.push(['pin', m.pinned_at ? 'برداشتن پین' : 'پین پیام', 'pin']);
        if (m.sender_id === me.id && !m.deleted_at) items.push(['del', 'حذف پیام', 'trash', true]);
        menu.innerHTML = items.map(([a, label, ic, danger]) =>
            `<button type="button" data-a="${a}"${danger ? ' class="danger"' : ''}>${UI.icon(ic)}<span>${label}</span></button>`).join('') +
            `<div class="row" style="gap:4px;padding:6px 4px 2px">${MENU_EMOJIS.map(e => `<button type="button" data-e="${e}" style="font-size:1.15rem;border:0;background:none;cursor:pointer">${e}</button>`).join('')}</div>`;
        /* clamp against the box's real size: the longest Persian label is wider
           than any fixed guess, and on a phone that pushed the menu off-screen */
        const pad = 10;
        const w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.max(pad, Math.min(window.innerWidth - w - pad, x)) + 'px';
        menu.style.top = Math.max(pad, Math.min(window.innerHeight - h - pad, y - 14)) + 'px';
        menu.classList.add('show');
        menu.onclick = async (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            menu.classList.remove('show');
            if (b.dataset.e) return react(m.id, b.dataset.e);
            const a = b.dataset.a;
            if (a === 'reply') setReply(m);
            if (a === 'save') saveToSaved(m);
            if (a === 'pin') togglePin(m);
            if (a === 'del') delMessage(m);
            if (a === 'copy') {
                const t = await decryptText(m);
                try { await navigator.clipboard.writeText(t); UI.toast('کپی شد', 'ok', 1500); }
                catch (err) { UI.toast('کپی نشد', 'err'); }
            }
            if (a === 'media') {
                const k = m.file_kind || m.kind;
                if (k === 'video') {
                    try { Gallery.open([{ url: await MediaCache.url(m, keyPair, me.id), type: 'video', name: m.file_name }], 0); }
                    catch (err) {}
                } else openGallery(m.id);
            }
        };
    }

    document.addEventListener('click', (e) => {
        const menu = UI.q('#msg-menu');
        if (menu && menu.classList.contains('show') && !e.target.closest('#msg-menu')) menu.classList.remove('show');
        const am = UI.q('#attach-menu');
        if (am && am.classList.contains('show') && !e.target.closest('#attach-menu') && !e.target.closest('#chat-attach'))
            am.classList.remove('show');
        const ep = UI.q('#emoji-pop');
        if (ep && ep.style.display === 'grid' && !e.target.closest('#emoji-pop') && !e.target.closest('#btn-emoji'))
            ep.style.display = 'none';
    });

    /* ---------- api calls ---------- */
    async function react(id, emoji) {
        const res = await UI.postJSON(`/api/message/${id}/react/`, { emoji });
        if (res.status !== 200) UI.toast('رأی ثبت نشد', 'err');
    }
    async function togglePin(m) {
        const pin = !m.pinned_at;
        const res = await UI.postJSON(`/api/message/${m.id}/pin/`, { pinned: pin });
        if (res.status !== 200) { UI.toast(pin ? 'پین نشد' : 'پین برداشته نشد', 'err'); return; }
        m.pinned_at = pin ? new Date().toISOString() : null;
        byId.set(m.id, m);
        removePin(m.id);
        if (pin) pins.unshift(m.id);
        scheduleRender();
        refreshPinBar();
    }
    async function delMessage(m) {
        const res = await UI.postJSON(`/api/message/${m.id}/delete/`, {});
        if (res.json && res.json.ok) UI.toast('پیام حذف شد', 'info', 1800);
        else UI.toast('حذف ممکن نیست', 'err');
    }
    function setReply(m) {
        replyTo = m;
        const strip = UI.q('#reply-strip');
        UI.q('#reply-strip-name').textContent = m.sender_username;
        UI.q('#reply-strip-text').textContent = m.file_id ? (m.file_name || 'پیوست') : 'پیام';
        if (m.content) decryptText(m).then(t => {
            if (replyTo && replyTo.id === m.id) UI.q('#reply-strip-text').textContent = t.slice(0, 60);
        });
        strip.style.display = 'flex';
        input.focus();
    }
    UI.q('#reply-cancel') && UI.q('#reply-cancel').addEventListener('click', clearReply);
    function clearReply() { replyTo = null; UI.q('#reply-strip').style.display = 'none'; }

    function removePin(id) { const i = pins.indexOf(id); if (i >= 0) pins.splice(i, 1); }

    function refreshPinBar() {
        const bar = UI.q('#pin-bar');
        if (!bar) return;
        const id = pins[0];
        if (!id) { bar.style.display = 'none'; return; }
        const m = byId.get(id);
        if (!m || m.deleted_at) { bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        const label = UI.q('#pin-bar-text');
        label.textContent = '…';
        label.dataset.id = id;
        if (m.file_id) label.textContent = 'پین: ' + (m.file_name || 'پیوست');
        else decryptText(m).then(t => { if (String(label.dataset.id) === String(id)) label.textContent = 'پین ' + m.sender_username + ': ' + t.slice(0, 70); });
    }
    UI.q('#pin-bar') && UI.q('#pin-bar').addEventListener('click', (e) => {
        if (e.target.closest('#pin-bar-close')) { UI.q('#pin-bar').style.display = 'none'; return; }
        jumpTo(UI.q('#pin-bar').dataset.id || pins[0]);
    });

    function jumpTo(id) {
        const row = rowOf.get(Number(id));
        if (!row) return;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 1200);
    }

    /* ---------- scroll helpers ---------- */
    function nearBottom(px) {
        return log.scrollHeight - log.scrollTop - log.clientHeight < (px || 120);
    }
    function scrollToEnd(smooth) {
        log.scrollTo({ top: log.scrollHeight, behavior: (smooth && UI.prefs.animations !== false) ? 'smooth' : 'auto' });
        unseen = 0; paintJump();
    }
    function paintJump() {
        const pill = UI.q('#jump-bottom');
        if (!pill) return;
        pill.style.display = nearBottom(300) && !unseen ? 'none' : 'grid';
        const b = UI.q('#jump-badge');
        b.style.display = unseen ? 'grid' : 'none';
        b.textContent = UI.fa(unseen);
    }
    UI.q('#jump-bottom') && UI.q('#jump-bottom').addEventListener('click', () => { scrollToEnd(true); markRead(); });
    log && log.addEventListener('scroll', () => {
        paintJump();
        if (log.scrollTop < 140) loadOlder();
        if (nearBottom()) markRead();
    });

    let lastRead = 0;
    function markRead() {
        if (Date.now() - lastRead < 4000) return;
        lastRead = Date.now();
        UI.postJSON(`/api/room/${room.id}/read/`, {}).catch(() => {});
    }

    /* ---------- typing ---------- */
    function showTyping(who) {
        let row = UI.q('#typing-row');
        if (!row) {
            row = document.createElement('div');
            row.id = 'typing-row';
            row.className = 'bubble in typing-row';
            row.innerHTML = '<i></i><i></i><i></i><span class="dim" style="font-size:.76rem;margin-inline-start:6px"></span>';
            log.appendChild(row);
        }
        UI.q('span', row).textContent = who + ' در حال نوشتن…';
        log.scrollTop = log.scrollHeight;
        clearTimeout(typingHide);
        typingHide = setTimeout(() => row.remove(), 2600);
    }
    function sendTyping() {
        const now = Date.now();
        if (typingTimer && now - typingTimer < 2500) return;
        typingTimer = now;
        if (wsReady) ws.send(JSON.stringify({ type: 'typing' }));
    }

    /* ---------- composer ---------- */
    function autosize() {
        input.style.height = 'auto';
        input.style.height = Math.min(132, input.scrollHeight) + 'px';
        composerRow.classList.toggle('has-text', !!input.value.trim());
    }
    input && input.addEventListener('input', () => { autosize(); sendTyping(); });

    async function send() {
        const text = input.value.trim();
        if (!text) return;
        if (!wsReady) return UI.toast('اتصال برقرار نیست، کمی صبر کنید', 'err');
        if (!Object.keys(memberKeys).length) return UI.toast('کلید عمومی اعضا نیست', 'err');
        try {
            const enc = await CryptoHelpers.encryptForMembers(text, memberKeys);
            ws.send(JSON.stringify({
                type: 'chat_message', kind: 'text',
                parent_id: replyTo ? replyTo.id : null, ...enc,
            }));
            input.value = ''; autosize(); clearReply();
            UI.ping('send');
        } catch (e) { UI.toast(e.message, 'err'); }
    }
    sendBtn && sendBtn.addEventListener('click', send);
    input && input.addEventListener('keydown', (e) => {
        const enterSends = UI.prefs.enter_to_send !== false;
        if (e.key === 'Enter' && !e.shiftKey && enterSends) { e.preventDefault(); send(); }
    });

    /* ---------- attachments ---------- */
    const attachBtn = UI.q('#chat-attach');
    const attachMenu = UI.q('#attach-menu');
    attachBtn && attachBtn.addEventListener('click', () => attachMenu.classList.toggle('show'));
    attachMenu && attachMenu.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        attachMenu.classList.remove('show');
        const act = b.dataset.act;
        if (act === 'poll') return composePoll();
        if (act === 'camera') return openCamera();
        if (act === 'photo') return UI.q('#chat-photo').click();
        if (act === 'video') return UI.q('#chat-video').click();
        if (act === 'music') return UI.q('#chat-music').click();
        if (act === 'file') return UI.q('#chat-file').click();
    });

    /* ---------- camera ---------- */
    const camSheet = UI.q('#camera-sheet');
    const camVideo = UI.q('#camera-video');
    let camStream = null;
    let camFacing = 'environment';

    function stopCamera() {
        if (camStream) camStream.getTracks().forEach(t => t.stop());
        camStream = null;
        if (camVideo) camVideo.srcObject = null;
    }
    function closeCamera() {
        stopCamera();
        if (camSheet) camSheet.classList.remove('show');
    }
    async function startCamera() {
        camStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: camFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
        });
        camVideo.srcObject = camStream;
        await camVideo.play().catch(() => {});
    }
    async function openCamera() {
        if (!camSheet || !camVideo) return;
        const input = UI.q('#chat-camera');
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return input.click();
        try {
            await startCamera();
        } catch (e) {
            /* no camera or permission refused: the capture input still opens one */
            input.click();
            return;
        }
        camSheet.classList.add('show');
    }
    async function shoot() {
        const w = camVideo.videoWidth, h = camVideo.videoHeight;
        if (!w || !h) return;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(camVideo, 0, 0, w, h);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .9));
        closeCamera();
        if (!blob) return UI.toast('عکس گرفته نشد', 'err');
        const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
        await uploadFiles([file], 'image');
    }
    const camClose = UI.q('#camera-close');
    const camShoot = UI.q('#camera-shoot');
    const camFlip = UI.q('#camera-flip');
    camClose && camClose.addEventListener('click', closeCamera);
    camShoot && camShoot.addEventListener('click', shoot);
    camFlip && camFlip.addEventListener('click', async () => {
        camFacing = camFacing === 'environment' ? 'user' : 'environment';
        stopCamera();
        try { await startCamera(); } catch (e) { closeCamera(); UI.q('#chat-camera').click(); }
    });
    window.addEventListener('pagehide', stopCamera);

    async function composePoll() {
        const p = await Polls.compose();
        if (!p) return;
        if (!wsReady) return UI.toast('اتصال برقرار نیست', 'err');
        try {
            const enc = await CryptoHelpers.encryptForMembers(Polls.encode(p.question, p.options), memberKeys);
            ws.send(JSON.stringify({ type: 'chat_message', kind: 'poll', ...enc }));
            UI.toast('نظرسنجی ارسال شد', 'ok');
        } catch (e) { UI.toast(e.message, 'err'); }
    }

    async function uploadOne(file, forcedKind, durationHint, caption) {
        const mime = file.type || '';
        let kind = forcedKind || MediaCache.kindOf(mime, '');
        const progress = UI.q('#upload-progress');
        progress.style.display = 'block';
        progress.textContent = 'رمزنگاری ' + (file.name || '') + '…';
        try {
            /* read tags while the file is still plaintext; they travel sealed with it */
            const tags = kind === 'audio' ? await Tags.read(file) : null;
            const enc = await CryptoHelpers.encryptFileForMembers(file, memberKeys, tags, caption);
            const meta = (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'voice')
                ? await MediaCache.probe(file, kind === 'image' ? 'image' : (kind === 'video' ? 'video' : 'audio'))
                : {};
            progress.textContent = 'ارسال…';
            const fd = new FormData();
            fd.append('file', enc.blob, 'enc.bin');
            fd.append('iv', enc.iv);
            fd.append('encrypted_keys', JSON.stringify(enc.encrypted_keys));
            fd.append('original_name', file.name || 'file');
            fd.append('mime_type', mime);
            fd.append('kind', kind);
            const ms = durationHint || meta.duration_ms;
            if (ms) fd.append('duration_ms', Math.round(ms));
            if (meta.width) fd.append('width', meta.width);
            if (meta.height) fd.append('height', meta.height);
            if (enc.meta_enc) fd.append('meta', JSON.stringify(enc.meta_enc));
            if (enc.text) {
                fd.append('content', enc.text);
                fd.append('text_iv', enc.text_iv);
            }
            const res = await fetch(`/api/room/${room.id}/upload-file/`, {
                method: 'POST', headers: { 'X-CSRFToken': UI.csrf() }, body: fd, credentials: 'same-origin',
            });
            if (!res.ok) throw new Error('server ' + res.status);
            UI.ping('send');
            progress.style.display = 'none';
            return true;
        } catch (e) {
            progress.textContent = 'خطا: ' + e.message;
            UI.toast('ارسال فایل ناموفق', 'err');
            return false;
        } finally {
            setTimeout(() => { progress.style.display = 'none'; }, 2500);
        }
    }

    /* The composer doubles as the caption box: its text attaches to the first
       file of a batch and is cleared only once that upload really landed. */
    async function uploadFiles(files, forced) {
        const caption = (input && input.value.trim()) || '';
        let used = false;
        for (let i = 0; i < files.length; i++) {
            const cap = used ? '' : caption;
            const ok = await uploadOne(files[i], forced, null, cap);
            if (ok && cap) {
                used = true;
                input.value = ''; autosize(); clearReply();
            }
        }
    }

    ['#chat-photo', '#chat-video', '#chat-music', '#chat-file', '#chat-camera'].forEach(sel => {
        const f = UI.q(sel);
        if (!f) return;
        f.addEventListener('change', async () => {
            const files = Array.from(f.files || []);
            if (!files.length) return;
            const forced = (sel === '#chat-photo' || sel === '#chat-camera') ? 'image'
                : sel === '#chat-video' ? 'video'
                : sel === '#chat-music' ? 'audio' : '';
            await uploadFiles(files, forced);
            f.value = '';
        });
    });

    const dropZone = UI.q('.room-shell');
    dropZone && ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); dropZone.classList.add('dropping');
    }));
    dropZone && ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); dropZone.classList.remove('dropping');
    }));
    dropZone && dropZone.addEventListener('drop', async (e) => {
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (files.length) await uploadFiles(files, '');
    });

    /* ---------- voice recorder ---------- */
    const recBar = UI.q('#rec-bar');
    const micBtn = UI.q('#btn-mic');
    let recInfo = null;

    micBtn && micBtn.addEventListener('click', async () => {
        if (recInfo) return;
        if (!Voice.supported()) return UI.toast('مرورگر از ضبط صدا پشتیبانی نمی‌کند', 'err');
        try {
            await Voice.start(UI.q('#rec-level'), UI.q('#rec-time'), {});
            recInfo = { started: Date.now() };
            composerRow.style.display = 'none';
            recBar.style.display = 'flex';
        } catch (e) { UI.toast('اجازه‌ی میکروفون داده نشد', 'err'); }
    });

    UI.q('#rec-cancel') && UI.q('#rec-cancel').addEventListener('click', async () => {
        await Voice.cancel();
        resetRecorderUI();
    });

    UI.q('#rec-send') && UI.q('#rec-send').addEventListener('click', async () => {
        const out = await Voice.stop();
        resetRecorderUI();
        if (!out || !out.blob || out.blob.size < 600) return;
        const named = new File([out.blob], out.name, { type: out.mime });
        await uploadOne(named, 'voice', out.duration_ms);
    });

    function resetRecorderUI() {
        recInfo = null;
        recBar.style.display = 'none';
        composerRow.style.display = '';
        UI.qa('#rec-level i').forEach(i => i.style.height = '20%');
    }

    /* ---------- emoji ---------- */
    const EMOJIS = ['😀','😁','😂','🤣','😊','😍','🥰','😘','😎','🤩','🥳','😭','😡','👍','👎','👏','🙏','💪','🔥','✨','🎉','❤️','💔','🙂','😉','😅','🤔','😴','🤒','🙈','🐶','🐱','🌸','🌙','☀️','⭐','🌈','☕','🍎','🍞','🍰','⚽','🏆','🎮','📚','💡','🚀','🕒','📌','✅'];
    const emojiPop = UI.q('#emoji-pop');
    if (emojiPop) {
        emojiPop.innerHTML = EMOJIS.map(e => `<button type="button">${e}</button>`).join('');
        UI.q('#btn-emoji').addEventListener('click', () => {
            const show = emojiPop.style.display !== 'grid';
            emojiPop.style.display = show ? 'grid' : 'none';
        });
        emojiPop.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            input.value += b.textContent;
            autosize();
            input.focus();
        });
    }

    /* ---------- room drawer ---------- */
    const drawer = UI.q('#room-drawer');
    const setDrawer = (open) => {
        if (!drawer) return;
        drawer.classList.toggle('show', open);
        document.body.classList.toggle('drawer-open', open);
    };
    const openDrawer = async () => {
        if (!drawer) return;
        setDrawer(true);
        UI.q('#drawer-name').textContent = room.name;
        UI.q('#drawer-topic').textContent = room.topic || '';
        try {
            const d = await UI.getJSON(`/api/room/${room.id}/members/`);
            const ul = UI.q('#drawer-members');
            ul.innerHTML = (d.members || []).map(u =>
                `<li class="contact-row"><span class="avatar sm">${UI.esc(u.username.slice(0, 1).toUpperCase())}</span><span class="n">${UI.esc(u.username)}</span></li>`).join('');
        } catch (e) {}
        try {
            const d = await UI.getJSON(`/api/room/${room.id}/media/?kind=image`);
            const grid = UI.q('#drawer-media');
            grid.innerHTML = '';
            for (const f of (d.files || []).slice(0, 9)) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                const img = document.createElement('img');
                cell.appendChild(img);
                cell.addEventListener('click', () => openGallery(f.message_id));
                grid.appendChild(cell);
                MediaCache.url({ file_id: f.file_id, iv: f.iv, encrypted_keys: f.encrypted_keys, mime_type: f.mime_type }, keyPair, me.id)
                    .then(u => { img.src = u; }).catch(() => { cell.textContent = '🖼'; });
            }
            if (!(d.files || []).length) grid.innerHTML = '<span class="muted small">فایلی نیست.</span>';
        } catch (e) {}
        UI.q('#toggle-mute-room').checked = !!prefs.muted;
        UI.q('#toggle-pin-room').checked = !!prefs.pinned;
        UI.q('#toggle-archive-room').checked = !!prefs.archived;
        try {
            const p = await UI.getJSON(`/api/room/${room.id}/pins/`);
            const list = p.pins || [];
            list.forEach(m => byId.set(m.id, m));
            pins.length = 0;
            list.forEach(m => pins.push(m.id));
            refreshPinBar();
        } catch (e) {}
    };
    UI.q('#btn-room-info') && UI.q('#btn-room-info').addEventListener('click', openDrawer);
    UI.q('#room-who') && UI.q('#room-who').addEventListener('click', openDrawer);
    UI.q('#drawer-close') && UI.q('#drawer-close').addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setDrawer(false); Gallery.close(); } });

    [['toggle-mute-room', 'muted'], ['toggle-pin-room', 'pinned'], ['toggle-archive-room', 'archived']].forEach(([id, key]) => {
        const el = UI.q('#' + id);
        if (!el) return;
        el.addEventListener('change', async () => {
            const res = await UI.postJSON(`/api/room/${room.id}/prefs/`, { [key]: el.checked });
            if (res.json && res.json.prefs) Object.assign(prefs, res.json.prefs);
            UI.toast(el.checked ? 'اعمال شد' : 'لغو شد', 'ok', 1500);
        });
    });

    /* ---------- search in room ---------- */
    const searchOv = UI.q('#search-overlay');
    UI.q('#btn-search-in-room') && UI.q('#btn-search-in-room').addEventListener('click', async () => {
        searchOv.classList.add('show');
        setTimeout(() => UI.q('#room-search-input').focus(), 80);
    });
    UI.q('#search-close') && UI.q('#search-close').addEventListener('click', () => searchOv.classList.remove('show'));
    UI.q('#room-search-input') && UI.q('#room-search-input').addEventListener('input', async (e) => {
        const q = e.target.value.trim().toLowerCase();
        const out = UI.q('#room-search-results');
        out.innerHTML = '';
        if (q.length < 2) return;
        const msgs = [...byId.values()].sort((a, b) => b.id - a.id);
        let shown = 0;
        for (const m of msgs) {
            if (shown >= 30) break;
            if (!m.content || m.kind === 'poll_vote' || m.kind === 'deleted') continue;
            const t = await decryptText(m);
            if (!t.toLowerCase().includes(q)) continue;
            const i = t.toLowerCase().indexOf(q);
            const li = document.createElement('li');
            li.className = 'chat-row';
            li.innerHTML = `<span class="mid"><span class="t"><span class="name">${UI.esc(m.sender_username)}</span></span>
                <span class="prev">${UI.esc(t.slice(Math.max(0, i - 25), i + 45))}</span></span>
                <span class="end"><span class="time">${UI.timeOf(m.timestamp)}</span></span>`;
            li.addEventListener('click', () => { searchOv.classList.remove('show'); jumpTo(m.id); });
            out.appendChild(li);
            shown++;
        }
        if (!shown) out.innerHTML = '<li class="muted" style="padding:12px">موردی پیدا نشد.</li>';
    });

    /* ------------------------------------------------------------------
       livekit calls
       ------------------------------------------------------------------ */
    const callUI = {
        box: UI.q('#group-call-box'), local: UI.q('#lk-local-box'), remote: UI.q('#lk-remote-container'),
        invite: UI.q('#group-invite-box'), inviteFrom: UI.q('#group-invite-from'),
        join: UI.q('#group-invite-join'), ignore: UI.q('#group-invite-ignore'),
        hangup: UI.q('#group-hangup'), mic: UI.q('#group-toggle-mic'), cam: UI.q('#group-toggle-cam'),
    };

    function handleCallInvite(d) {
        if (Number(d.from) === Number(me.id)) return;
        if (window.GroupCallE2EE && GroupCallE2EE.active) return;
        if (!callUI.invite) return;
        callUI.inviteFrom.textContent = d.from_username;
        callUI.invite.dataset.sessionId = d.call_session_id;
        callUI.invite.style.display = 'flex';
    }

    async function createCallSession() {
        const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));
        const senderPubB64 = CryptoHelpers.publicKeyToB64(keyPair.publicKey);
        const encryptedKeys = {};
        for (const [uid, pubB64] of Object.entries(memberKeys)) {
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            encryptedKeys[uid] = {
                nonce: CryptoHelpers.b64(nonce),
                box: CryptoHelpers.b64(nacl.box(raw, nonce, CryptoHelpers.publicKeyFromB64(pubB64), keyPair.secretKey)),
                sender_pub: senderPubB64,
            };
        }
        const res = await fetch(`/api/room/${room.id}/create-call-session/`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': UI.csrf() },
            body: JSON.stringify({ encrypted_keys: encryptedKeys }),
        });
        if (!res.ok) throw new Error('تماس برقرار نشد');
        return res.json();
    }

    async function joinCall(sid, video) {
        const res = await fetch(`/api/room/${room.id}/livekit-token/${sid}/`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('token');
        const data = await res.json();
        callUI.box.style.display = 'block';
        await GroupCallE2EE.join({
            token: data.token, url: data.url,
            encryptedKeyObj: data.encrypted_aes_key_for_me,
            myKeyPair: keyPair, callSessionId: sid, video: !!video,
            onStateChange: (s) => { if (s === 'idle') callUI.box.style.display = 'none'; },
        });
    }

    async function startCall(video) {
        const d = await createCallSession();
        ws.send(JSON.stringify({ type: 'call_group_invite', call_session_id: d.call_session_id }));
        await joinCall(d.call_session_id, video);
    }

    UI.q('#btn-call-group') && UI.q('#btn-call-group').addEventListener('click', () => {
        startCall(false).catch((e) => UI.toast(e.message, 'err'));
    });
    UI.q('#btn-video-call') && UI.q('#btn-video-call').addEventListener('click', () => {
        startCall(true).catch((e) => UI.toast(e.message, 'err'));
    });
    callUI.join && callUI.join.addEventListener('click', async () => {
        const sid = callUI.invite.dataset.sessionId;
        callUI.invite.style.display = 'none';
        try { await joinCall(parseInt(sid, 10)); } catch (e) { UI.toast('ورود به تماس ناموفق', 'err'); }
    });
    callUI.ignore && callUI.ignore.addEventListener('click', () => { callUI.invite.style.display = 'none'; });
    callUI.hangup && callUI.hangup.addEventListener('click', () => GroupCallE2EE.leave());
    callUI.mic && callUI.mic.addEventListener('click', () => GroupCallE2EE.toggleMic());
    callUI.cam && callUI.cam.addEventListener('click', () => GroupCallE2EE.toggleCam());

    /* ------------------------------------------------------------------
       go
       ------------------------------------------------------------------ */
    UI.q('.composer').style.display = 'flex';
    connect();
    await loadInitial();
    await primeVotes();
    scheduleRender();
    paintJump();
    autosize();

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { unseen = 0; paintJump(); markRead(); scrollToEnd(false); }
    });

    window.addEventListener('beforeunload', () => {
        if (window.GroupCallE2EE && GroupCallE2EE.active) { try { GroupCallE2EE.leave(); } catch (e) {} }
        Voice.stopAll();
        clearTimeout(lockTimer);
    });
})();
