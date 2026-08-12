/**
 * Prediction Chess — Client.
 *
 * Der Client rendert und schlägt vor. Brett, Münzen, Effekte, Sichtfeld und
 * Spielende liegen ausschließlich im Server; jedes Paket vom Server überschreibt
 * den lokalen Zustand vollständig. Zugvorschläge werden lokal mit derselben
 * `move-gen.js` berechnet, die der Server benutzt — deshalb werden legale Züge
 * nie fälschlich abgelehnt.
 */
'use strict';

(function () {

    const $ = (id) => document.getElementById(id);
    const el = DomUtils.el;
    const clear = DomUtils.clear;
    const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const sqName = (r, c) => FILES[c] + (8 - r);

    const socket = io('/prediction-chess', { transports: ['websocket', 'polling'] });

    // =================================================================
    // Zustand — alles Serverwahrheit, nichts wird lokal fortgeschrieben
    // =================================================================
    const S = {
        roomCode: null,
        playerId: null,
        color: 'w',
        board: MoveGen.createInitialBoard(),
        turn: 'w',
        hasMoved: MoveGen.createHasMoved(),
        enPassantTarget: null,
        captured: { w: [], b: [] },
        coins: { w: 0, b: 0 },
        streak: { w: 0, b: 0 },
        effects: [],
        castlingBanned: { w: false, b: false },
        boughtThisTurn: false,
        doubleSecond: false,
        pendingDouble: false,
        hasPrediction: false,
        moveDeadline: 0,
        fogPlies: 0,
        visible: null,
        inCheck: false,
        started: false,
        over: false,
        names: { w: 'White', b: 'Black' },
        pfps: { w: '', b: '' },

        selected: null,          // {r,c}
        legal: [],
        lastMove: null,
        arrow: null,             // eigener offener Tipp {fromR,..}
        arrow2: null,
        revealed: null,          // {arrows, hit} nach der Auflösung
        pendingPromotion: null,
        targeting: null,         // {itemId, slotIndex, picked:[], choice}
        historyRows: []
    };

    const isMyTurn = () => S.turn === S.color && S.started && !S.over;
    const foe = () => (S.color === 'w' ? 'b' : 'w');

    // =================================================================
    // Brett bauen
    // =================================================================
    const boardEl = $('board');
    const squares = [];

    function buildBoard() {
        clear(boardEl);
        squares.length = 0;
        for (let r = 0; r < 8; r++) {
            squares[r] = [];
            for (let c = 0; c < 8; c++) {
                const sq = el('div', {
                    class: 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark'),
                    role: 'gridcell',
                    tabindex: '0',
                    'aria-label': sqName(r, c),
                    dataset: { r: String(r), c: String(c) }
                });
                const img = el('img', { class: 'piece-img hidden', alt: '' });
                sq.appendChild(img);
                sq.addEventListener('click', () => onSquareClick(r, c));
                sq.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSquareKey(r, c); }
                    if (e.key === 'Escape') cancelEverything();
                });
                // Rechtsklick-Ziehen zeichnet den Tipp (chess.com-Muskelgedächtnis).
                sq.addEventListener('contextmenu', (e) => e.preventDefault());
                sq.addEventListener('mousedown', (e) => {
                    if (e.button === 2) { e.preventDefault(); startDrag(r, c); }
                });
                sq.addEventListener('mouseenter', () => { if (drag.from) updateDraft(r, c); });
                sq.addEventListener('mouseup', (e) => {
                    if (e.button === 2 && drag.from) { e.preventDefault(); endDrag(r, c); }
                });
                boardEl.appendChild(sq);
                squares[r][c] = sq;
            }
        }
        boardEl.classList.toggle('flipped', S.color === 'b');
    }

    function pieceSrc(ch) {
        const map = PieceAssets.PIECE_IMAGES;
        return map[ch] || '';
    }

    function render() {
        const visSet = S.visible ? new Set(S.visible.map(v => v.r + ',' + v.c)) : null;

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const sq = squares[r][c];
                const img = sq.firstChild;
                const p = S.board[r] ? S.board[r][c] : null;

                if (p) {
                    img.src = pieceSrc(p);
                    img.classList.remove('hidden');
                    img.alt = p;
                } else {
                    img.classList.add('hidden');
                    img.removeAttribute('src');
                    img.alt = '';
                }

                sq.classList.remove('selected', 'valid-move', 'capture-move', 'last-move',
                                    'in-check', 'target-ok', 'target-chosen', 'fogged');

                if (visSet && !visSet.has(r + ',' + c)) sq.classList.add('fogged');
            }
        }

        if (S.lastMove) {
            const { fromR, fromC, toR, toC } = S.lastMove;
            if (squares[fromR]) squares[fromR][fromC].classList.add('last-move');
            if (squares[toR]) squares[toR][toC].classList.add('last-move');
        }

        if (S.inCheck && S.turn === S.color) {
            const k = MoveGen.findKing(S.board, S.color);
            if (k) squares[k.r][k.c].classList.add('in-check');
        }

        if (S.targeting) {
            renderTargeting();
        } else if (S.selected) {
            squares[S.selected.r][S.selected.c].classList.add('selected');
            for (const m of S.legal) {
                squares[m.r][m.c].classList.add(m.type === 'capture' || m.type === 'en_passant'
                    ? 'capture-move' : 'valid-move');
            }
        }

        drawArrows();
        renderEffects();
        renderScores();
        renderShop();
        renderPredictBar();
    }

    // =================================================================
    // Zugvorschläge — identische Regeln wie auf dem Server
    // =================================================================
    function movementOpts(extra) {
        const frozen = S.effects
            .filter(e => e.id === 'freeze' && e.owner !== S.color && e.target)
            .map(e => e.target);
        const blocked = S.effects
            .filter(e => e.id === 'minefield' && e.owner !== S.color && e.squares)
            .reduce((a, e) => a.concat(e.squares), []);
        const cav = S.effects.find(e => e.id === 'cavalry' && e.owner === S.color);
        const storm = S.effects.find(e => e.id === 'pawn_storm' && e.owner === S.color);
        return Object.assign({
            hasMoved: S.hasMoved,
            enPassantTarget: S.enPassantTarget,
            frozen: frozen.length ? frozen : null,
            blockedTargets: blocked.length ? blocked : null,
            extraPattern: cav && cav.target ? { r: cav.target.r, c: cav.target.c, type: 'knight' } : null,
            pawnDoubleAnywhere: !!storm
        }, extra || {});
    }

    function legalFrom(r, c) {
        const extra = S.doubleSecond ? { noCapture: true, noCheck: true } : null;
        return MoveGen.legalMoves(S.board, r, c, movementOpts(extra));
    }

    // =================================================================
    // Klicks
    // =================================================================
    function onSquareClick(r, c) {
        if (S.targeting) return pickTarget(r, c);
        if (!isMyTurn() || S.pendingPromotion) return;

        const p = S.board[r][c];

        if (S.selected) {
            const m = S.legal.find(x => x.r === r && x.c === c);
            if (m) return tryMove(S.selected.r, S.selected.c, r, c, m);
            if (p && MoveGen.colorOf(p) === S.color) return select(r, c);
            S.selected = null; S.legal = []; return render();
        }
        if (p && MoveGen.colorOf(p) === S.color) select(r, c);
    }

    /** Tastatur: erst Figur, dann Ziel — und für den Tipp zwei Felder. */
    let keyArrowFrom = null;
    function onSquareKey(r, c) {
        if (S.targeting) return pickTarget(r, c);
        if (keyArrowFrom) {
            setArrow({ fromR: keyArrowFrom.r, fromC: keyArrowFrom.c, toR: r, toC: c });
            keyArrowFrom = null;
            return;
        }
        onSquareClick(r, c);
    }

    function select(r, c) {
        S.selected = { r, c };
        S.legal = legalFrom(r, c);
        render();
    }

    function tryMove(fromR, fromC, toR, toC, move) {
        const piece = S.board[fromR][fromC];
        const isPromo = piece.toLowerCase() === 'p' && (toR === 0 || toR === 7);
        if (isPromo) {
            S.pendingPromotion = { fromR, fromC, toR, toC, type: move.type };
            return showPromotion();
        }
        sendMove(fromR, fromC, toR, toC, null);
    }

    function sendMove(fromR, fromC, toR, toC, promotedTo) {
        socket.emit('request_prediction_move', {
            roomCode: S.roomCode,
            fromR, fromC, toR, toC,
            promotedTo,
            prediction: S.arrow,
            prediction2: S.arrow2
        });
        S.selected = null; S.legal = []; S.pendingPromotion = null;
        render();
    }

    function showPromotion() {
        const box = $('promo-options');
        clear(box);
        ['q', 'r', 'n', 'b'].forEach(ch => {
            const code = S.color === 'w' ? ch.toUpperCase() : ch;
            const img = el('img', { class: 'promo-piece', src: pieceSrc(code), alt: ch });
            img.addEventListener('click', () => {
                const pp = S.pendingPromotion;
                $('promotion-modal').style.display = 'none';
                sendMove(pp.fromR, pp.fromC, pp.toR, pp.toC, ch);
            });
            box.appendChild(img);
        });
        $('promotion-modal').style.display = 'flex';
    }

    // =================================================================
    // Prediction-Pfeile
    // =================================================================
    const drag = { from: null, draft: null };

    function startDrag(r, c) {
        if (!canPredict()) return;
        drag.from = { r, c };
        drag.draft = null;
    }
    function updateDraft(r, c) {
        if (!drag.from) return;
        drag.draft = { fromR: drag.from.r, fromC: drag.from.c, toR: r, toC: c };
        drawArrows();
    }
    function endDrag(r, c) {
        const from = drag.from;
        drag.from = null; drag.draft = null;
        if (!from) return;
        if (from.r === r && from.c === c) { drawArrows(); return; }
        setArrow({ fromR: from.r, fromC: from.c, toR: r, toC: c });
    }

    /** Tippen darf man nur, solange man am Zug ist — Zug und Tipp gehen zusammen raus. */
    function canPredict() {
        return isMyTurn() && !S.doubleSecond;
    }

    function hasSecondGuess() {
        return S.effects.some(e => e.id === 'second_guess' && e.owner === S.color);
    }

    function setArrow(a) {
        if (!canPredict()) return;
        if (!S.arrow) S.arrow = a;
        else if (hasSecondGuess() && !sameArrow(S.arrow, a)) S.arrow2 = a;
        else { S.arrow = a; S.arrow2 = null; }
        render();
    }

    const sameArrow = (a, b) => !!a && !!b && a.fromR === b.fromR && a.fromC === b.fromC &&
                                a.toR === b.toR && a.toC === b.toC;

    function clearArrows() { S.arrow = null; S.arrow2 = null; render(); }

    /** Bildkoordinaten eines Feldmittelpunkts — berücksichtigt gedrehtes Brett. */
    function center(r, c) {
        const rr = S.color === 'b' ? 7 - r : r;
        const cc = S.color === 'b' ? 7 - c : c;
        return { x: cc * 75 + 37.5, y: rr * 75 + 37.5 };
    }

    /**
     * Handgezeichnet wirkender Pfeil: leicht gebogen, mit dicker schwarzer
     * Kontur darunter — passt zum Scribble-Stil der anderen Modi.
     */
    function arrowPath(a) {
        const p1 = center(a.fromR, a.fromC);
        const p2 = center(a.toR, a.toC);
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const bow = Math.min(26, len * 0.14);
        const mx = (p1.x + p2.x) / 2 + nx * bow;
        const my = (p1.y + p2.y) / 2 + ny * bow;

        // Spitze etwas vor der Feldmitte enden lassen
        const back = 20;
        const ex = p2.x - (dx / len) * back;
        const ey = p2.y - (dy / len) * back;

        const ang = Math.atan2(ey - my, ex - mx);
        const head = 20;
        const h1x = ex - head * Math.cos(ang - 0.45), h1y = ey - head * Math.sin(ang - 0.45);
        const h2x = ex - head * Math.cos(ang + 0.45), h2y = ey - head * Math.sin(ang + 0.45);

        return `M ${p1.x} ${p1.y} Q ${mx} ${my} ${ex} ${ey} M ${h1x} ${h1y} L ${ex} ${ey} L ${h2x} ${h2y}`;
    }

    function svgPath(d, cls) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        p.setAttribute('class', 'arrow-line ' + cls);
        return p;
    }

    function drawArrows() {
        const layer = $('arrow-layer');
        while (layer.firstChild) layer.removeChild(layer.firstChild);

        const add = (a, cls, extraCls) => {
            if (!a) return;
            const d = arrowPath(a);
            layer.appendChild(svgPath(d, 'arrow-outline' + (extraCls ? ' ' + extraCls : '')));
            layer.appendChild(svgPath(d, cls + (extraCls ? ' ' + extraCls : '')));
        };

        if (S.revealed) {
            const cls = S.revealed.hit ? 'arrow-hit' : 'arrow-miss';
            const fx = S.revealed.hit ? 'arrow-flash' : 'arrow-break';
            (S.revealed.arrows || []).forEach(a => add(a, cls, fx));
        }
        add(S.arrow, 'arrow-pending');
        add(S.arrow2, 'arrow-pending');
        if (drag.draft) add(drag.draft, 'arrow-draft');
    }

    // =================================================================
    // Shop
    // =================================================================
    function shopLockReason() {
        if (!S.started) return 'Waiting for the game to start';
        if (S.over) return 'Game over';
        if (S.turn !== S.color) return "Not your turn";
        if (S.inCheck) return 'You are in check';
        if (S.boughtThisTurn) return 'One item per turn';
        return null;
    }

    function buildShop() {
        const grid = $('shop-grid');
        clear(grid);
        let lastCat = null;
        Items.SHOP_ORDER.forEach(id => {
            const item = Items.getItem(id);
            if (item.category !== lastCat) {
                lastCat = item.category;
                grid.appendChild(el('div', { class: 'shop-cat' }, Items.CATEGORY_LABEL[item.category]));
            }
            const card = el('button', {
                type: 'button', class: 'shop-card', dataset: { item: id },
                'aria-label': item.name + ', ' + item.price + ' coins'
            });
            card.appendChild(el('span', { class: 'ico' }, item.icon));
            card.appendChild(el('span', { class: 'nm' }, item.name));
            card.appendChild(el('span', { class: 'pr' }, '🪙 ' + item.price));
            card.addEventListener('click', () => beginPurchase(id));
            card.addEventListener('mouseenter', (e) => showTip(e, item));
            card.addEventListener('mouseleave', hideTip);
            card.addEventListener('focus', (e) => showTip(e, item));
            card.addEventListener('blur', hideTip);
            grid.appendChild(card);
        });
    }

    function renderShop() {
        const reason = shopLockReason();
        const section = $('shop-section');
        section.classList.toggle('locked', !!reason);
        $('shop-lock').classList.toggle('hidden', !reason);
        if (reason) $('shop-lock-reason').textContent = reason;
        $('shop-coins').textContent = String(S.coins[S.color]);

        const activeIds = S.effects.filter(e => e.owner === S.color && e.id).map(e => e.id);
        document.querySelectorAll('.shop-card').forEach(card => {
            const item = Items.getItem(card.dataset.item);
            const gate = Items.canBuy(item.id, {
                myTurn: S.turn === S.color,
                inCheck: S.inCheck && S.turn === S.color,
                boughtThisTurn: S.boughtThisTurn,
                coins: S.coins[S.color],
                captured: S.captured[S.color],
                enemyEffectCount: S.effects.filter(e => e.owner !== S.color).length,
                enemyCanStillCastle: !S.castlingBanned[foe()],
                activeIds
            });
            card.disabled = !!reason || !gate.ok;
            card.classList.toggle('too-pricey', S.coins[S.color] < item.price);
        });
    }

    function showTip(e, item) {
        const tip = $('item-tip');
        clear(tip);
        tip.appendChild(el('b', {}, item.icon + '  ' + item.name));
        tip.appendChild(el('div', { class: 'tip-price' }, '🪙 ' + item.price +
            (item.duration ? '  ·  ' + item.duration + ' turns' : '') +
            (item.charges ? '  ·  ' + item.charges + '× use' : '')));
        tip.appendChild(el('div', {}, item.rules));
        tip.classList.remove('hidden');
        const rect = e.currentTarget.getBoundingClientRect();
        const top = Math.max(8, Math.min(window.innerHeight - 180, rect.top));
        tip.style.top = top + 'px';
        tip.style.left = Math.max(8, rect.left - 272) + 'px';
    }
    function hideTip() { $('item-tip').classList.add('hidden'); }

    function beginPurchase(itemId) {
        if (shopLockReason()) return;
        const item = Items.getItem(itemId);
        if (!item) return;
        hideTip();
        if (!item.targets.length) return commitPurchase(itemId, [], null);
        S.targeting = { itemId, slotIndex: 0, picked: [], choice: null };
        S.selected = null; S.legal = [];
        openTargeting();
    }

    function openTargeting() {
        const t = S.targeting;
        const item = Items.getItem(t.itemId);
        const slot = item.targets[t.slotIndex];
        $('board-wrapper').classList.add('targeting');
        $('target-banner').classList.remove('hidden');
        $('target-banner-text').textContent = item.icon + ' ' + item.name + ' — ' +
            (slot.label || 'Choose a target');

        if (slot.kind === 'capturedPiece') return pickCapturedPiece();
        render();
    }

    function renderTargeting() {
        const t = S.targeting;
        const item = Items.getItem(t.itemId);
        const slot = item.targets[t.slotIndex];
        if (!slot || slot.kind === 'capturedPiece') return;
        const ok = Items.validTargetSquares(slot, S.board, S.color);
        const taken = new Set(t.picked.filter(p => p && p.r !== undefined).map(p => p.r + ',' + p.c));
        ok.forEach(s => {
            if (taken.has(s.r + ',' + s.c)) return;
            squares[s.r][s.c].classList.add('target-ok');
        });
        t.picked.forEach(p => {
            if (p && p.r !== undefined) squares[p.r][p.c].classList.add('target-chosen');
        });
    }

    function pickTarget(r, c) {
        const t = S.targeting;
        const item = Items.getItem(t.itemId);
        const slot = item.targets[t.slotIndex];
        const v = Items.isValidTarget(slot, S.board, S.color, { r, c }, S.captured[S.color]);
        if (!v.ok) return flashError(v.reason);
        if (t.picked.some(p => p && p.r === r && p.c === c)) return flashError('Already chosen.');

        t.picked.push({ r, c });
        t.slotIndex += 1;
        if (t.slotIndex >= item.targets.length) return finishTargeting();
        openTargeting();
    }

    /** Wiedergeburt: erst die geschlagene Figur wählen, dann das Feld. */
    function pickCapturedPiece() {
        const list = Items.normalizeCaptured(S.captured[S.color]);
        if (!list.length) { cancelTargeting(); return flashError('You have not lost a piece yet.'); }
        const box = $('choice-options');
        clear(box);
        list.forEach((ch, i) => {
            const code = S.color === 'w' ? ch.toUpperCase() : ch.toLowerCase();
            const img = el('img', { class: 'promo-piece', src: pieceSrc(code), alt: ch });
            img.addEventListener('click', () => {
                $('choice-modal').style.display = 'none';
                S.targeting.picked.push({ index: i });
                S.targeting.slotIndex += 1;
                const item = Items.getItem(S.targeting.itemId);
                if (S.targeting.slotIndex >= item.targets.length) finishTargeting();
                else openTargeting();
            });
            box.appendChild(img);
        });
        $('choice-modal').querySelector('.choice-title').textContent = 'Bring back…';
        $('choice-modal').style.display = 'flex';
    }

    function finishTargeting() {
        const t = S.targeting;
        // Aufwertung eines Bauern braucht noch die Zielfigur.
        if (t.itemId === 'upgrade') {
            const p0 = t.picked[0];
            const options = Items.upgradeOptions(S.board[p0.r][p0.c]);
            if (options.length > 1) return askUpgradeChoice(options);
        }
        commitPurchase(t.itemId, t.picked, t.choice);
    }

    function askUpgradeChoice(options) {
        const box = $('choice-options');
        clear(box);
        options.forEach(ch => {
            const code = S.color === 'w' ? ch.toUpperCase() : ch;
            const img = el('img', { class: 'promo-piece', src: pieceSrc(code), alt: ch });
            img.addEventListener('click', () => {
                $('choice-modal').style.display = 'none';
                commitPurchase(S.targeting.itemId, S.targeting.picked, ch);
            });
            box.appendChild(img);
        });
        $('choice-modal').querySelector('.choice-title').textContent = 'Upgrade into…';
        $('choice-modal').style.display = 'flex';
    }

    function commitPurchase(itemId, targets, choice) {
        socket.emit('buy_item', { roomCode: S.roomCode, itemId, targets, choice });
        cancelTargeting();
    }

    function cancelTargeting() {
        S.targeting = null;
        $('board-wrapper').classList.remove('targeting');
        $('target-banner').classList.add('hidden');
        $('choice-modal').style.display = 'none';
        render();
    }

    function cancelEverything() {
        if (S.targeting) return cancelTargeting();
        keyArrowFrom = null;
        S.selected = null; S.legal = [];
        render();
    }

    // =================================================================
    // Anzeigen
    // =================================================================
    function renderScores() {
        const me = S.color, them = foe();
        setCoins($('bottom-coins'), S.coins[me]);
        setCoins($('top-coins'), S.coins[them]);
        setStreak($('bottom-streak'), S.streak[me]);
        setStreak($('top-streak'), S.streak[them]);
        $('bottom-player-name').textContent = S.names[me] || 'You';
        $('top-player-name').textContent = S.names[them] || 'Opponent';
        setAvatar($('bottom-pfp'), S.pfps[me]);
        setAvatar($('top-pfp'), S.pfps[them]);
        $('my-role-tag').textContent = me === 'w' ? 'WHITE' : 'BLACK';
        $('turn-display-tag').textContent = S.over ? 'GAME OVER'
            : (S.turn === 'w' ? "WHITE'S TURN" : "BLACK'S TURN");
    }

    function setAvatar(img, url) {
        const safe = DomUtils.safeImageUrl(url);
        if (safe) { img.src = safe; img.classList.remove('hidden'); }
        else img.classList.add('hidden');
    }

    function setCoins(box, n) {
        const numEl = box.querySelector('.coin-num');
        if (numEl.textContent !== String(n)) {
            numEl.textContent = String(n);
            box.classList.remove('bump');
            void box.offsetWidth;
            box.classList.add('bump');
        }
    }

    function setStreak(box, n) {
        clear(box);
        for (let i = 0; i < 8; i++) {
            box.appendChild(el('div', { class: 'streak-dot' + (i < n ? ' on' : '') }));
        }
        const mult = Items.streakMultiplier(n);
        if (mult > 1) box.appendChild(el('span', { class: 'streak-mult' }, '×' + mult));
    }

    function renderEffects() {
        const mine = $('effects-mine'), theirs = $('effects-theirs');
        clear(mine); clear(theirs);
        S.effects.forEach(e => {
            const chip = el('div', {
                class: 'effect-chip ' + (e.owner === S.color ? 'mine' : 'theirs')
            }, Items.describeEffect(e));
            (e.owner === S.color ? mine : theirs).appendChild(chip);
        });
    }

    function renderPredictBar() {
        const bar = $('predict-bar'), txt = $('predict-text');
        bar.classList.remove('armed', 'locked');
        $('btn-clear-arrow').classList.toggle('hidden', !S.arrow);

        if (!S.started || S.over) { bar.classList.add('locked'); txt.textContent = 'No prediction right now.'; return; }
        if (S.doubleSecond) { bar.classList.add('locked'); txt.textContent = 'Second move of your Double Move — no capture, no check.'; return; }
        if (!isMyTurn()) { bar.classList.add('locked'); txt.textContent = 'Waiting for your opponent…'; return; }

        if (S.arrow2) { bar.classList.add('armed'); txt.textContent = 'Two calls locked in: ' + arrowText(S.arrow) + ' and ' + arrowText(S.arrow2) + '.'; return; }
        if (S.arrow) {
            bar.classList.add('armed');
            txt.textContent = 'Calling ' + arrowText(S.arrow) + '.' +
                (hasSecondGuess() ? ' Draw a second arrow if you like.' : ' Now make your move.');
            return;
        }
        txt.textContent = 'Call their reply: right-click drag an arrow (or Enter on two squares). Skipping resets your streak.';
    }

    const arrowText = (a) => a ? sqName(a.fromR, a.fromC) + '→' + sqName(a.toR, a.toC) : '';

    function pushHistory(mover, move, result) {
        const row = el('div', { class: 'history-row' });
        row.appendChild(el('span', {}, (mover === 'w' ? '⚪ ' : '⚫ ') +
            sqName(move.fromR, move.fromC) + '–' + sqName(move.toR, move.toC)));
        if (result && !result.skipped) {
            row.appendChild(el('span', { class: result.hit ? 'hit' : 'miss' },
                result.hit ? '✓ +' + result.coins : '✗'));
        }
        const list = $('history-list');
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    function flashError(msg) {
        const bar = $('predict-text');
        const old = bar.textContent;
        bar.textContent = '⚠ ' + msg;
        setTimeout(() => { if (bar.textContent === '⚠ ' + msg) bar.textContent = old; }, 2200);
    }

    function coinPop(amount) {
        if (!amount) return;
        const host = $('game-container');
        const pop = el('div', { class: 'coin-fly' }, '+' + amount + ' 🪙');
        pop.style.right = '20px';
        pop.style.bottom = '90px';
        host.appendChild(pop);
        setTimeout(() => pop.remove(), 1200);
    }

    // =================================================================
    // Zug-Timer
    // =================================================================
    let timerRaf = null;
    function tickTimer() {
        const mineBar = $('bottom-timer'), theirBar = $('top-timer');
        const active = S.turn === S.color ? mineBar : theirBar;
        const idle = S.turn === S.color ? theirBar : mineBar;
        idle.style.width = '100%';
        idle.className = 'timer-fill';

        if (!S.started || S.over || !S.moveDeadline) {
            active.style.width = '100%';
            active.className = 'timer-fill';
        } else {
            const left = Math.max(0, S.moveDeadline - Date.now());
            const pct = Math.max(0, Math.min(100, (left / 90000) * 100));
            active.style.width = pct + '%';
            active.className = 'timer-fill' + (left < 10000 ? ' danger' : left < 20000 ? ' warn' : '');
        }
        timerRaf = requestAnimationFrame(tickTimer);
    }

    // =================================================================
    // Serverpakete übernehmen
    // =================================================================
    function absorb(d) {
        if (!d) return;
        if (d.board) S.board = d.board;
        if (d.turn) S.turn = d.turn;
        if (d.hasMoved) S.hasMoved = d.hasMoved;
        S.enPassantTarget = d.enPassantTarget || null;
        if (d.captured) S.captured = d.captured;
        if (d.coins) S.coins = d.coins;
        if (d.streak) S.streak = d.streak;
        if (d.effects) S.effects = d.effects;
        if (d.castlingBanned) S.castlingBanned = d.castlingBanned;
        if (typeof d.boughtThisTurn === 'boolean') S.boughtThisTurn = d.boughtThisTurn;
        if (typeof d.doubleSecond === 'boolean') S.doubleSecond = d.doubleSecond;
        if (typeof d.pendingDouble === 'boolean') S.pendingDouble = d.pendingDouble;
        if (typeof d.hasPrediction === 'boolean') S.hasPrediction = d.hasPrediction;
        if (typeof d.moveDeadline === 'number') S.moveDeadline = d.moveDeadline;
        if (typeof d.fogPlies === 'number') S.fogPlies = d.fogPlies;
        S.visible = d.visible || null;
        if (typeof d.inCheck === 'boolean') S.inCheck = d.inCheck;
        $('fog-badge').classList.toggle('hidden', !S.fogPlies);
        if (S.fogPlies) $('fog-plies').textContent = String(S.fogPlies);
    }

    function showScreen(name) {
        ['menu-screen', 'lobby-screen', 'game-screen'].forEach(id => {
            $(id).classList.toggle('hidden', id !== name);
        });
    }

    // =================================================================
    // Socket
    // =================================================================
    socket.on('connect', () => { $('splash-screen').style.display = 'none'; });
    socket.on('connect_error', () => {
        $('splash-screen').style.display = 'none';
        $('error-msg').textContent = 'Could not reach the server. Try again in a moment.';
    });
    socket.on('error_msg', (msg) => {
        if (!S.started) $('error-msg').textContent = String(msg);
        else flashError(String(msg));
        Sfx.play('illegal');
    });

    socket.on('prediction_room_created', (d) => {
        S.roomCode = d.roomCode; S.color = d.color; S.playerId = d.playerId;
        S.names[d.color] = ($('player-name').value || 'You').slice(0, 15);
        absorb(d);
        $('display-room-code').textContent = d.roomCode;
        try { sessionStorage.setItem('pred_seat', JSON.stringify({ roomCode: d.roomCode, playerId: d.playerId, color: d.color })); } catch (e) { /* egal */ }
        showScreen('lobby-screen');
    });

    socket.on('prediction_room_joined', (d) => {
        S.roomCode = d.roomCode; S.color = d.color; S.playerId = d.playerId;
        S.names[d.color] = ($('player-name').value || 'You').slice(0, 15);
        absorb(d);
        try { sessionStorage.setItem('pred_seat', JSON.stringify({ roomCode: d.roomCode, playerId: d.playerId, color: d.color })); } catch (e) { /* egal */ }
        buildBoard(); render();
        showScreen('game-screen');
    });

    socket.on('opponent_info', (d) => {
        ['w', 'b'].forEach(col => {
            if (d[col]) { S.names[col] = d[col].name; S.pfps[col] = d[col].pfp; }
        });
        if (S.roomCode) { buildBoard(); render(); showScreen('game-screen'); }
    });

    socket.on('ready_state', (r) => {
        if (r[S.color]) {
            const b = $('btn-ready');
            b.classList.add('is-ready');
            b.textContent = 'WAITING…';
            b.disabled = true;
        }
    });

    socket.on('start_match_countdown', () => {
        $('status-banner').classList.remove('hidden');
        $('status-banner-text').textContent = 'Get ready…';
        Sfx.play('game-start');
    });

    socket.on('match_started', (d) => {
        absorb(d);
        S.started = true;
        $('status-banner').classList.add('hidden');
        $('btn-ready').classList.add('hidden');   // ab jetzt nur noch im Weg
        render();
    });

    socket.on('apply_prediction_move', (d) => {
        absorb(d);
        S.lastMove = d.move;
        S.selected = null; S.legal = [];

        const pr = d.predictionResult;
        if (pr && pr.by === S.color) {
            // Mein Tipp wurde gerade aufgelöst.
            S.revealed = { arrows: pr.arrows, hit: pr.hit };
            S.arrow = null; S.arrow2 = null;
            if (pr.hit) { coinPop(pr.coins); Sfx.play('notify'); }
            setTimeout(() => { S.revealed = null; drawArrows(); }, 2600);
        } else if (pr && pr.arrows && pr.arrows.length) {
            // Der Tipp des Gegners über meinen Zug — auch der wird aufgedeckt.
            S.revealed = { arrows: pr.arrows, hit: pr.hit };
            setTimeout(() => { S.revealed = null; drawArrows(); }, 2600);
        }

        if (d.mover === S.color && !d.extraMove) { S.arrow = null; S.arrow2 = null; }
        if (d.mover !== S.color) { S.arrow = null; S.arrow2 = null; }

        pushHistory(d.mover, d.move, pr && pr.by === d.mover ? null : pr);
        Sfx.playMove({ type: d.move.type === 'capture' ? 'capture' : d.move.type });
        render();
    });

    socket.on('item_purchased', (d) => {
        absorb(d);
        const who = d.by === S.color ? 'You' : 'Opponent';
        flashError(''); // laufende Warnung wegräumen
        $('predict-text').textContent = `${who}: ${d.icon} ${d.label}`;
        if (d.by === S.color) {
            const card = document.querySelector(`.shop-card[data-item="${d.itemId}"]`);
            if (card) { card.classList.add('just-bought'); setTimeout(() => card.classList.remove('just-bought'), 700); }
        }
        Sfx.play('promote');
        render();
        setTimeout(renderPredictBar, 2000);
    });

    socket.on('draw_offered', () => { $('draw-modal').style.display = 'flex'; });
    socket.on('draw_declined', () => flashError('Draw declined.'));
    socket.on('opponent_disconnected', () => flashError('Opponent lost connection — they forfeit if they do not return.'));
    socket.on('opponent_reconnected', () => flashError('Opponent is back.'));

    socket.on('game_over', (d) => {
        S.over = true;
        $('game-over').style.display = 'flex';
        const won = d.winnerColor === S.color;
        $('winner-text').textContent = d.winnerColor === null
            ? 'Draw — ' + d.reason
            : (won ? 'You win! ' : 'You lose. ') + '(' + d.reason + ')';

        const box = $('summary-box');
        clear(box);
        if (d.summary) {
            const me = S.color, them = foe();
            const rows = [
                ['Coins earned', d.summary.coins[me], d.summary.coins[them]],
                ['Calls made', d.summary.guesses[me], d.summary.guesses[them]],
                ['Calls hit', d.summary.hits[me], d.summary.hits[them]],
                ['Best streak', d.summary.bestStreak[me], d.summary.bestStreak[them]]
            ];
            box.appendChild(el('div', {}, '')).appendChild(el('b', {}, 'You / Opponent'));
            rows.forEach(([label, a, b]) => {
                const row = el('div', {});
                row.appendChild(el('span', {}, label));
                row.appendChild(el('b', {}, a + ' / ' + b));
                box.appendChild(row);
            });
        }
        Sfx.play('game-end');
        render();
    });

    socket.on('prediction_room_reconnected', (d) => {
        S.roomCode = d.roomCode; S.color = d.color; S.playerId = d.playerId;
        absorb(d);
        S.started = true;
        buildBoard(); render();
        showScreen('game-screen');
    });

    // =================================================================
    // Bedienelemente
    // =================================================================
    $('btn-create').addEventListener('click', () => {
        socket.emit('create_prediction_room', {
            playerName: $('player-name').value,
            colorChoice: $('color-choice').value
        });
    });

    $('btn-join').addEventListener('click', () => {
        const code = ($('room-code-input').value || '').trim().toUpperCase();
        if (!code) return void ($('error-msg').textContent = 'Enter a room code.');
        socket.emit('join_prediction_room', { roomCode: code, playerName: $('player-name').value });
    });

    $('btn-ready').addEventListener('click', () => socket.emit('player_ready', { roomCode: S.roomCode }));
    $('btn-clear-arrow').addEventListener('click', clearArrows);
    $('btn-resign').addEventListener('click', () => {
        if (confirm('Resign this game?')) socket.emit('resign', { roomCode: S.roomCode });
    });
    $('btn-offer-draw').addEventListener('click', () => socket.emit('offer_draw', { roomCode: S.roomCode }));
    $('btn-accept-draw').addEventListener('click', () => {
        $('draw-modal').style.display = 'none';
        socket.emit('respond_draw', { roomCode: S.roomCode, accepted: true });
    });
    $('btn-decline-draw').addEventListener('click', () => {
        $('draw-modal').style.display = 'none';
        socket.emit('respond_draw', { roomCode: S.roomCode, accepted: false });
    });
    $('btn-leave-lobby').addEventListener('click', () => location.reload());
    $('btn-leave-game').addEventListener('click', () => location.reload());
    $('btn-back-to-menu').addEventListener('click', () => location.reload());

    const rulesModal = DomUtils.makeAccessibleModal
        ? DomUtils.makeAccessibleModal($('rules-modal'))
        : { open: () => { $('rules-modal').style.display = 'flex'; }, close: () => { $('rules-modal').style.display = 'none'; } };
    $('btn-show-rules').addEventListener('click', () => rulesModal.open());
    $('btn-menu-rules').addEventListener('click', () => rulesModal.open());
    $('close-rules-btn').addEventListener('click', () => rulesModal.close());

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelEverything(); });
    document.addEventListener('mouseup', () => { if (drag.from) { drag.from = null; drag.draft = null; drawArrows(); } });

    // Regelbuch-Tabelle aus derselben Registry wie der Shop
    (function fillRulesTable() {
        const host = $('rules-item-table');
        let cat = null;
        Items.SHOP_ORDER.forEach(id => {
            const item = Items.getItem(id);
            if (item.category !== cat) {
                cat = item.category;
                host.appendChild(el('div', { class: 'item-cat' }, Items.CATEGORY_LABEL[cat]));
            }
            const row = el('div', { class: 'item-row' });
            row.appendChild(el('span', { class: 'ico' }, item.icon));
            const mid = el('span', { class: 'nm' }, item.name);
            mid.appendChild(el('span', { class: 'ds' }, item.short));
            row.appendChild(mid);
            row.appendChild(el('span', { class: 'pr' }, '🪙 ' + item.price));
            host.appendChild(row);
        });
    })();

    // Reconnect nach einem Reload
    (function tryReconnect() {
        let seat = null;
        try { seat = JSON.parse(sessionStorage.getItem('pred_seat') || 'null'); } catch (e) { seat = null; }
        if (!seat || !seat.roomCode) return;
        socket.on('connect', () => {
            socket.emit('reconnect_prediction_room', seat);
        });
    })();

    buildShop();
    buildBoard();
    render();
    tickTimer();
    if (Sfx.mountFloatingToggle) Sfx.mountFloatingToggle();
})();
