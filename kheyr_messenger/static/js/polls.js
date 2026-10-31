/* ============================================================
   Polls — composer modal + encrypted payload format + render
   ============================================================ */
(function () {
    'use strict';

    const MIN_OPTS = 2, MAX_OPTS = 8;

    function optionRow(value) {
        const inp = document.createElement('input');
        inp.className = 'input';
        inp.type = 'text';
        inp.maxLength = 120;
        inp.placeholder = 'گزینه ' + UI.fa(UI.qa('#poll-options .input').length + 1);
        inp.value = value || '';
        return inp;
    }

    let opened = false;
    function ensureDom() {
        const ov = UI.q('#poll-overlay');
        if (!ov) return null;
        const list = UI.q('#poll-options', ov);
        if (list && !list.childElementCount) {
            list.appendChild(optionRow(''));
            list.appendChild(optionRow(''));
        }
        const add = UI.q('#poll-add-opt', ov);
        if (add && !add.dataset.wired) {
            add.dataset.wired = '1';
            add.addEventListener('click', () => {
                const l = UI.q('#poll-options', ov);
                if (UI.qa('.input', l).length >= MAX_OPTS) { UI.toast('حداکثر ' + UI.fa(MAX_OPTS) + ' گزینه', 'info'); return; }
                l.appendChild(optionRow(''));
                UI.q('.input:last-child', l).focus();
            });
        }
        return ov;
    }

    const Polls = {
        compose() {
            const ov = ensureDom();
            if (!ov) return Promise.resolve(null);
            return new Promise((resolve) => {
                const q = UI.q('#poll-question', ov);
                const list = UI.q('#poll-options', ov);
                list.innerHTML = ''; list.appendChild(optionRow('')); list.appendChild(optionRow(''));
                q.value = '';
                ov.classList.add('show');
                opened = true;
                setTimeout(() => q.focus(), 80);

                const finish = (val) => {
                    ov.classList.remove('show');
                    opened = false;
                    UI.q('#poll-cancel', ov).removeEventListener('click', onCancel);
                    UI.q('#poll-send', ov).removeEventListener('click', onSend);
                    document.removeEventListener('keydown', onKey);
                    resolve(val);
                };
                const onCancel = () => finish(null);
                const onSend = () => {
                    const question = q.value.trim();
                    const opts = UI.qa('.input', list).map(i => i.value.trim()).filter(Boolean);
                    if (!question) { UI.toast('پرسش را بنویسید', 'err'); return; }
                    if (opts.length < MIN_OPTS) { UI.toast('حداقل ' + UI.fa(MIN_OPTS) + ' گزینه', 'err'); return; }
                    finish({ question, options: opts });
                };
                const onKey = (e) => { if (e.key === 'Escape' && opened) finish(null); };
                UI.q('#poll-cancel', ov).addEventListener('click', onCancel);
                UI.q('#poll-send', ov).addEventListener('click', onSend);
                document.addEventListener('keydown', onKey);
            });
        },

        encode(question, options) {
            return JSON.stringify({ t: 'poll', q: question, o: options });
        },
        encodeVote(optIndex, pollId) {
            return JSON.stringify({ t: 'vote', v: optIndex, p: pollId });
        },
        parse(text) {
            if (!text || text[0] !== '{') return null;
            try {
                const j = JSON.parse(text);
                if (j && j.t === 'poll' && Array.isArray(j.o)) return j;
                if (j && j.t === 'vote') return j;
            } catch (e) {}
            return null;
        },
        isVote(text) {
            const j = Polls.parse(text);
            return j && j.t === 'vote' ? j : null;
        },

        /* votes: array of {by, v} — last vote per user wins */
        tally(options, votes) {
            const last = {};
            (votes || []).forEach(v => { if (v && v.v >= 0) last[v.by] = v.v; });
            const counts = options.map(() => 0);
            Object.values(last).forEach(v => { if (v < counts.length) counts[v]++; });
            return { counts, voters: last, total: Object.keys(last).length };
        },

        render(host, poll, votes, myId, onVote) {
            const t = Polls.tally(poll.o, votes);
            host.className = 'poll';
            host.innerHTML =
                '<h4></h4>' +
                '<div class="opts"></div>' +
                '<div class="total"></div>';
            UI.q('h4', host).textContent = poll.q;
            const wrap = UI.q('.opts', host);
            const myVote = t.voters[String(myId)];

            poll.o.forEach((label, i) => {
                const pct = t.total ? Math.round((t.counts[i] / t.total) * 100) : 0;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'opt' + (myVote === i ? ' chosen' : '');
                b.innerHTML = '<span class="fill"></span>' +
                    '<span class="lbl"><span></span><span class="pct"></span></span>';
                UI.q('.lbl > span:first-child', b).textContent = label;
                UI.q('.pct', b).textContent = t.total ? UI.fa(pct) + '٪' : '';
                setTimeout(() => { UI.q('.fill', b).style.width = pct + '%'; }, 40);
                b.addEventListener('click', () => onVote && onVote(i));
                wrap.appendChild(b);
            });
            UI.q('.total', host).textContent =
                UI.fa(t.total) + ' رأی' + (myVote === undefined ? ' — برای رأی دادن بزنید' : ' — رأی شما ثبت شد');
        },
    };

    window.Polls = Polls;
})();
