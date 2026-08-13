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

    // Damit man in der Konsole sofort sieht, welche Fassung geladen ist.
    const CLIENT_VERSION = '2026-08-12f';
    window.PREDICTION_VERSION = CLIENT_VERSION;
    console.info('Prediction Chess Client ' + CLIENT_VERSION);

    /**
     * Fehlende oder veraltete gemeinsame Dateien duerfen nicht in einer stumm
     * toten Seite enden. Vorher war das Symptom: Tipps liessen sich zeichnen,
     * aber keine Figur anklicken — der Fehler stand nur in der Konsole.
     */
    function startupFailure(missing) {
        try { document.getElementById('splash-screen').style.display = 'none'; } catch (e) { /* egal */ }
        const box = document.createElement('div');
        box.setAttribute('role', 'alert');
        box.style.cssText = 'position:fixed;inset:20px auto auto 50%;transform:translateX(-50%);' +
            'z-index:99999;max-width:640px;background:#e74c3c;color:#fff;border:4px solid #000;' +
            'box-shadow:6px 6px 0 rgba(0,0,0,.9);padding:16px 20px;font-family:sans-serif;' +
            'font-size:16px;line-height:1.5;border-radius:15px 5px 20px 10px/5px 20px 10px 15px';
        const h = document.createElement('b');
        h.textContent = 'Prediction Chess cannot start.';
        h.style.cssText = 'display:block;font-size:20px;margin-bottom:6px';
        const p = document.createElement('div');
        p.textContent = 'These files are missing or out of date: ' + missing.join(', ') +
            '. If you just deployed, this is usually a stale browser cache — ' +
            'reload with Ctrl+Shift+R (Cmd+Shift+R on Mac). Otherwise upload the ' +
            'current version of the file.';
        box.appendChild(h); box.appendChild(p);
        document.body.appendChild(box);
        console.error('Prediction Chess: veraltete/fehlende Dateien:', missing.join(', '));
    }

    const MISSING = [];
    if (typeof MoveGen !== 'object' || !MoveGen || typeof MoveGen.legalMoves !== 'function') {
        MISSING.push('/shared/move-gen.js');
    }
    if (typeof Items !== 'object' || !Items || !Items.ITEMS) MISSING.push('/shared/items.js');
    if (typeof DomUtils !== 'object' || !DomUtils) MISSING.push('/shared/dom-utils.js');
    if (typeof BoardArrows !== 'object' || !BoardArrows) MISSING.push('/shared/board-arrows.js');
    if (MISSING.length) { startupFailure(MISSING); return; }

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
        revealed: null,          // {arrows, hit} nach der Auflösung
        pendingMove: null,       // gewählter Zug, wartet auf den Tipp
        pendingBuy: null,        // gewähltes Zug-Item, wartet auf den Tipp
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
                sq.appendChild(el('img', { class: 'piece-img hidden', alt: '' }));
                // Eigenes Element statt ::after — die Pseudoelemente sind schon
                // von den Zugvorschlägen belegt.
                sq.appendChild(el('span', { class: 'sq-marker' }));
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

    /**
     * Brett zum Anzeigen. Ein bereits gewählter, aber noch nicht abgeschickter
     * Zug wird nur lokal vorweggenommen — der Gegner sieht davon nichts, bis
     * der Tipp steht und beides zusammen rausgeht.
     */
    function displayBoard() {
        if (!S.pendingMove) return S.board;
        try {
            const m = S.pendingMove;
            return MoveGen.applyClassicMove(S.board, {
                fromR: m.fromR, fromC: m.fromC, toR: m.toR, toC: m.toC,
                type: m.type, promotedTo: m.promotedTo
            }, { enPassantTarget: S.enPassantTarget }).board;
        } catch (e) { return S.board; }
    }

    function render() {
        const visSet = S.visible ? new Set(S.visible.map(v => v.r + ',' + v.c)) : null;
        const view = displayBoard();

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const sq = squares[r][c];
                const img = sq.firstChild;
                const p = view[r] ? view[r][c] : null;

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
                                    'in-check', 'target-ok', 'target-chosen', 'fogged',
                                    'pending-move', 'pending-item', 'call-from');

                const marker = sq.lastChild;
                marker.className = 'sq-marker';
                marker.textContent = '';

                if (visSet && !visSet.has(r + ',' + c)) sq.classList.add('fogged');
            }
        }

        if (S.lastMove) {
            const { fromR, fromC, toR, toC } = S.lastMove;
            if (squares[fromR]) squares[fromR][fromC].classList.add('last-move');
            if (squares[toR]) squares[toR][toC].classList.add('last-move');
        }

        if (S.pendingMove) {
            const m = S.pendingMove;
            squares[m.fromR][m.fromC].classList.add('pending-move');
            squares[m.toR][m.toC].classList.add('pending-move');
        }
        if (S.pendingBuy) {
            (S.pendingBuy.targets || []).forEach(t => {
                if (t && MoveGen.validCoords(t.r, t.c)) squares[t.r][t.c].classList.add('pending-item');
            });
        }
        // Erstes von zwei Feldern der Tipp-Eingabe (Touch/Tastatur). Ohne
        // Markierung weiss man nach dem ersten Antippen nicht, ob es gezaehlt
        // hat.
        if (keyArrowFrom && MoveGen.validCoords(keyArrowFrom.r, keyArrowFrom.c)) {
            squares[keyArrowFrom.r][keyArrowFrom.c].classList.add('call-from');
        }

        renderEffectMarkers();

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

    /**
     * Laufende Effekte direkt auf dem Brett zeigen: eine Mine sieht man sonst
     * nur in der Effektleiste und läuft prompt hinein.
     */
    const MARKERS = {
        minefield: { icon: '💣', cls: 'mine' },
        freeze: { icon: '🔗', cls: 'shackled' },
        cavalry: { icon: '🐴', cls: 'mounted' }
    };

    function renderEffectMarkers() {
        S.effects.forEach(eff => {
            const m = MARKERS[eff.id];
            if (!m) return;
            const spots = eff.squares || (eff.target ? [eff.target] : []);
            spots.forEach(t => {
                if (!t || !MoveGen.validCoords(t.r, t.c)) return;
                const marker = squares[t.r][t.c].lastChild;
                marker.className = 'sq-marker ' + m.cls + (eff.owner === S.color ? ' own' : ' foe');
                marker.textContent = m.icon;
                marker.title = Items.describeEffect(eff);
            });
        });
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
        try { onSquareClickInner(r, c); }
        catch (err) {
            // Lieber eine sichtbare Meldung als ein Brett, das auf nichts reagiert.
            console.error('Klick auf ' + sqName(r, c) + ' fehlgeschlagen:', err);
            flashError('Something broke on this click — see the browser console.');
        }
    }

    function onSquareClickInner(r, c) {
        if (S.targeting) return pickTarget(r, c);
        if (!isMyTurn() || S.pendingPromotion) return;

        // TOUCH: Sobald der eigene Zug feststeht, meinen zwei Antipper den
        // Tipp — erst das Startfeld des Gegners, dann sein Ziel. Auf Touch
        // gibt es kein Rechtsklick-Ziehen, ohne das hier waere der Pflicht-
        // Tipp auf dem Handy schlicht nicht eingebbar (man kaeme nie zum
        // "Send turn"). Zuruecknehmen geht ueber "Take back".
        if (isCoarsePointer() && awaitingCall()) return pickArrowSquare(r, c);

        // Ein Klick aufs Brett heisst: ich will es anders machen. Der offene
        // Zug wird zurueckgenommen und der Klick ganz normal weiterverarbeitet.
        // Auf der Maus bleibt das so — dort zeichnet der Rechtsklick den Tipp.
        if (awaitingCall()) {
            S.pendingMove = null; S.pendingBuy = null; S.arrow = null;
        }

        const p = S.board[r][c];

        if (S.selected) {
            const m = S.legal.find(x => x.r === r && x.c === c);
            if (m) return tryMove(S.selected.r, S.selected.c, r, c, m);
            if (p && MoveGen.colorOf(p) === S.color) return select(r, c);
            S.selected = null; S.legal = []; return render();
        }
        if (p && MoveGen.colorOf(p) === S.color) select(r, c);
    }

    /**
     * Erstes von zwei Feldern, aus denen der Tipp entsteht. Wird von Touch
     * (Antippen) und Tastatur (Enter) gemeinsam benutzt.
     */
    let keyArrowFrom = null;

    /**
     * Grobe Zeiger = Finger. Wird bei jedem Aufruf frisch ausgewertet, damit
     * ein angestecktes Keyboard oder ein Wechsel Touch/Maus sofort greift.
     */
    function isCoarsePointer() {
        return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
    }

    /**
     * Zwei-Felder-Eingabe fuer den Tipp. Erstes Antippen merkt das Startfeld,
     * das zweite setzt den Pfeil. Dasselbe Feld zweimal hebt die Auswahl auf.
     */
    function pickArrowSquare(r, c) {
        if (!canPredict()) return;
        if (!keyArrowFrom) {
            keyArrowFrom = { r, c };
            render();
            return;
        }
        if (keyArrowFrom.r === r && keyArrowFrom.c === c) {
            keyArrowFrom = null;
            render();
            return;
        }
        const from = keyArrowFrom;
        keyArrowFrom = null;
        setArrow({ fromR: from.r, fromC: from.c, toR: r, toC: c });
    }

    /** Tastatur: erst Figur, dann Ziel — und für den Tipp zwei Felder. */
    function onSquareKey(r, c) {
        if (S.targeting) return pickTarget(r, c);
        // Steht der eigene Zug schon, gehoert Enter dem Tipp. Vorher war
        // dieser Zweig toter Code: keyArrowFrom wurde nie gesetzt, der im
        // Regelbuch beschriebene Tastaturweg funktionierte also nicht.
        if (keyArrowFrom || (isMyTurn() && awaitingCall() && !S.pendingPromotion)) {
            return pickArrowSquare(r, c);
        }
        onSquareClick(r, c);
    }

    function select(r, c) {
        S.selected = { r, c };
        S.legal = legalFrom(r, c);
        render();
    }

    /** Wartet etwas darauf, dass der Tipp gezeichnet wird? */
    function awaitingCall() {
        return !!(S.pendingMove || S.pendingBuy);
    }

    function tryMove(fromR, fromC, toR, toC, move) {
        const piece = S.board[fromR][fromC];
        const isPromo = piece.toLowerCase() === 'p' && (toR === 0 || toR === 7);
        if (isPromo) {
            S.pendingPromotion = { fromR, fromC, toR, toC, type: move.type };
            return showPromotion();
        }
        stageMove(fromR, fromC, toR, toC, null, move.type);
    }

    /**
     * Erst ziehen, dann tippen: der Zug wird nur lokal vorgemerkt und erst
     * zusammen mit dem Pfeil abgeschickt. Der Gegner sieht bis dahin nichts.
     */
    function stageMove(fromR, fromC, toR, toC, promotedTo, type) {
        S.pendingMove = { fromR, fromC, toR, toC, promotedTo, type };
        S.selected = null; S.legal = []; S.pendingPromotion = null;
        // Der zweite Zug eines Double Move braucht keinen neuen Tipp.
        if (S.doubleSecond) return commitTurn();
        render();
        Sfx.play('move');
    }

    /** Schickt Zug (oder Zug-Item) samt Tipp ab. */
    function commitTurn() {
        if (S.pendingBuy) {
            socket.emit('buy_item', {
                roomCode: S.roomCode,
                itemId: S.pendingBuy.itemId,
                targets: S.pendingBuy.targets,
                choice: S.pendingBuy.choice,
                prediction: S.arrow
            });
        } else if (S.pendingMove) {
            const m = S.pendingMove;
            socket.emit('request_prediction_move', {
                roomCode: S.roomCode,
                fromR: m.fromR, fromC: m.fromC, toR: m.toR, toC: m.toC,
                promotedTo: m.promotedTo,
                prediction: S.arrow
            });
        }
        S.pendingMove = null; S.pendingBuy = null; S.arrow = null;
        render();
    }

    /** Nimmt einen vorgemerkten Zug oder Item-Einsatz zurück. */
    function cancelPending() {
        if (!awaitingCall()) return false;
        S.pendingMove = null; S.pendingBuy = null; S.arrow = null;
        keyArrowFrom = null;
        render();
        return true;
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
                stageMove(pp.fromR, pp.fromC, pp.toR, pp.toC, ch, pp.type);
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

    /** Getippt wird erst, wenn der eigene Zug feststeht. */
    function canPredict() {
        return isMyTurn() && awaitingCall();
    }

    /**
     * Der Pfeil wird nur vorgemerkt. Abgeschickt wird erst auf Bestaetigung —
     * ein danebengezogener Pfeil waere sonst sofort verbindlich.
     */
    function setArrow(a) {
        if (!canPredict()) {
            flashError('Choose your move first, then call their reply.');
            return;
        }
        S.arrow = a;
        render();
        // Damit Enter direkt greift, wenn man per Tastatur gezeichnet hat.
        const send = $('btn-send-turn');
        if (!send.classList.contains('is-hidden')) send.focus();
    }

    const sameArrow = (a, b) => !!a && !!b && a.fromR === b.fromR && a.fromC === b.fromC &&
                                a.toR === b.toR && a.toC === b.toC;

    function clearArrows() { S.arrow = null; render(); }

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
        if (awaitingCall()) return 'Call their reply first';
        return null;
    }

    function buildShop() {
        const grid = $('shop-grid');
        clear(grid);
        // Bewusst ohne Kategoriezeilen: 16 Items ergeben genau ein 4x4-Raster,
        // das komplett ins Bild passt. Die Kategorie steht im Tooltip.
        Items.SHOP_ORDER.forEach(id => {
            const item = Items.getItem(id);
            const card = el('button', {
                type: 'button', class: 'shop-card', dataset: { item: id },
                'aria-label': item.name + ', ' + item.price + ' coins'
            });
            // Icon und Preis in einer Zeile: so bleibt darunter Platz fuer
            // zweizeilige Namen, ohne dass der Preis abgeschnitten wird.
            const head = el('span', { class: 'head' });
            head.appendChild(el('span', { class: 'ico' }, item.icon));
            head.appendChild(el('span', { class: 'pr' }, '🪙' + item.price));
            card.appendChild(head);
            card.appendChild(el('span', { class: 'nm' }, item.name));
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
        tip.appendChild(el('div', { class: 'tip-cat' }, Items.CATEGORY_LABEL[item.category]));
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
        const item = Items.getItem(itemId);
        cancelTargeting();
        if (item && item.isMove) {
            // Zug-Items verbrauchen den Zug, also gilt auch hier: erst der Zug,
            // dann der Tipp. Abgeschickt wird beides zusammen.
            S.pendingBuy = { itemId, targets, choice };
            render();
            return;
        }
        socket.emit('buy_item', { roomCode: S.roomCode, itemId, targets, choice });
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
        if (cancelPending()) return;
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
        const back = $('btn-clear-arrow'), send = $('btn-send-turn');
        bar.classList.remove('armed', 'locked', 'required');
        back.classList.toggle('is-hidden', !awaitingCall());
        send.classList.toggle('is-hidden', !(awaitingCall() && S.arrow));

        if (!S.started || S.over) { bar.classList.add('locked'); txt.textContent = 'No prediction right now.'; return; }
        if (S.doubleSecond) { bar.classList.add('locked'); txt.textContent = 'Double Move, second move — no capture, no check.'; return; }
        if (!isMyTurn()) { bar.classList.add('locked'); txt.textContent = 'Waiting for your opponent…'; return; }

        const what = S.pendingBuy
            ? ((Items.getItem(S.pendingBuy.itemId) || {}).name || 'Item')
            : (S.pendingMove ? sqName(S.pendingMove.fromR, S.pendingMove.fromC) + '–' +
                               sqName(S.pendingMove.toR, S.pendingMove.toC) : '');

        // Auf Touch gibt es kein Rechtsklick-Ziehen — dort wird der Tipp
        // angetippt. Die Leiste muss den jeweils gueltigen Weg nennen, sonst
        // sucht man auf dem Handy nach einer Geste, die es nicht gibt.
        const touch = isCoarsePointer();

        if (awaitingCall() && S.arrow) {
            bar.classList.add('armed');
            txt.textContent = what + ', calling ' + arrowText(S.arrow) +
                (touch ? '. Tap two squares to change it, then send.'
                       : '. Redraw to change it, then send.');
            return;
        }
        if (awaitingCall()) {
            bar.classList.add('required');
            if (touch) {
                txt.textContent = keyArrowFrom
                    ? what + ' ready — from ' + sqName(keyArrowFrom.r, keyArrowFrom.c) +
                      ', now tap where they go.'
                    : what + ' ready — tap the square they move from, then their target.';
            } else {
                txt.textContent = what + ' ready — now call their reply. Nothing is sent yet.';
            }
            return;
        }
        txt.textContent = touch
            ? 'Your move first — then tap two squares to call their reply.'
            : 'Your move first — then call their reply with a right-click drag.';
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
    // Raum-Chat
    // =================================================================
    function addChatMessage(msg) {
        const log = $('chat-log');
        const empty = log.querySelector('.chat-empty');
        if (empty) empty.remove();
        const row = el('div', { class: 'chat-msg ' + (msg.color === 'w' ? 'w' : 'b') });
        // Name und Text ausschliesslich als Text — nie als HTML.
        row.appendChild(el('span', { class: 'who' }, (msg.name || 'Player') + ':'));
        row.appendChild(document.createTextNode(msg.text));
        log.appendChild(row);
        while (log.children.length > 60) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
        // Damit ein eingeklappter Chat (Handy) auf neue Nachrichten hinweisen
        // kann, statt stumm zu bleiben.
        markChatUnread();
    }

    function chatNote(text) {
        const log = $('chat-log');
        const empty = log.querySelector('.chat-empty');
        if (empty) empty.remove();
        log.appendChild(el('div', { class: 'chat-msg system' }, text));
        log.scrollTop = log.scrollHeight;
    }

    function resetChat() {
        const log = $('chat-log');
        clear(log);
        log.appendChild(el('div', { class: 'chat-empty' }, 'No messages yet.'));
    }

    /**
     * Auf dem Handy steht der Chat eingeklappt unter dem Brett. Ohne Hinweis
     * merkt man dort nicht, dass der Gegner geschrieben hat. Wird von
     * setupChatCollapse ueberschrieben, sobald der Knopf existiert.
     */
    let markChatUnread = () => {};

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
        // Der Knopf wird zur Statusanzeige statt zu verschwinden: gleiche Hoehe,
        // keine Luecke, und das Layout ruckelt nicht.
        const rb = $('btn-ready');
        rb.classList.add('is-ready');
        rb.textContent = 'MATCH LIVE';
        rb.disabled = true;
        render();
    });

    socket.on('apply_prediction_move', (d) => {
        absorb(d);
        // Nach jedem Zug ist die Rechnung hinfaellig.
        if (boardAnnotations) boardAnnotations.clear();
        S.lastMove = d.move;
        S.selected = null; S.legal = [];

        const pr = d.predictionResult;
        if (pr && pr.by === S.color) {
            // Mein Tipp wurde gerade aufgelöst.
            S.revealed = { arrows: pr.arrows, hit: pr.hit };
            S.arrow = null;
            if (pr.hit) { coinPop(pr.coins); Sfx.play('notify'); }
            setTimeout(() => { S.revealed = null; drawArrows(); }, 2600);
        } else if (pr && pr.arrows && pr.arrows.length) {
            // Der Tipp des Gegners über meinen Zug — auch der wird aufgedeckt.
            S.revealed = { arrows: pr.arrows, hit: pr.hit };
            setTimeout(() => { S.revealed = null; drawArrows(); }, 2600);
        }

        S.arrow = null; S.pendingMove = null; S.pendingBuy = null;

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

    socket.on('room_chat', (msg) => { if (msg && msg.text) addChatMessage(msg); });
    socket.on('room_chat_history', (list) => {
        resetChat();
        if (Array.isArray(list)) list.forEach(addChatMessage);
    });

    socket.on('draw_offered', () => { $('draw-modal').style.display = 'flex'; });
    socket.on('draw_declined', () => flashError('Draw declined.'));
    socket.on('opponent_disconnected', () => {
        flashError('Opponent lost connection — they forfeit if they do not return.');
        chatNote('Opponent lost connection.');
    });
    socket.on('opponent_reconnected', () => {
        flashError('Opponent is back.');
        chatNote('Opponent is back.');
    });

    socket.on('game_over', (d) => {
        S.over = true;
        try { sessionStorage.removeItem('pred_seat'); } catch (e) { /* egal */ }
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
    $('btn-clear-arrow').addEventListener('click', cancelPending);
    $('btn-send-turn').addEventListener('click', () => { if (S.arrow && awaitingCall()) commitTurn(); });

    $('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('chat-input');
        const text = input.value.trim();
        if (!text || !S.roomCode) return;
        socket.emit('room_chat', { roomCode: S.roomCode, text });
        input.value = '';
        input.focus();
    });

    /**
     * Chat einklappen. Auf dem Handy steht der Chat unter dem Brett (siehe
     * `order` in style.css) und startet zugeklappt — offen schiebt er den
     * Rest sonst einen halben Bildschirm nach unten. Auf dem Desktop ist der
     * Knopf per CSS unsichtbar und der Chat immer offen, damit sich an der
     * gewohnten Ansicht nichts aendert.
     */
    (function setupChatCollapse() {
        const panel = document.querySelector('.chat-panel');
        const btn = $('chat-toggle');
        if (!panel || !btn) return;

        const setCollapsed = (yes) => {
            panel.classList.toggle('collapsed', yes);
            btn.textContent = yes ? 'Show' : 'Hide';
            btn.setAttribute('aria-expanded', yes ? 'false' : 'true');
        };

        // Dieselbe Grenze wie der Media-Query, der den Knopf sichtbar macht.
        const narrow = window.matchMedia(
            '(max-width: 900px), (orientation: landscape) and (max-height: 600px)');
        setCollapsed(narrow.matches);

        btn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));

        // Beim Drehen ins Breite wieder aufklappen — sonst bleibt der Chat auf
        // dem Desktop heimlich zu, wo der Knopf unsichtbar ist.
        const onChange = (e) => { if (!e.matches) setCollapsed(false); };
        if (narrow.addEventListener) narrow.addEventListener('change', onChange);
        else if (narrow.addListener) narrow.addListener(onChange);

        markChatUnread = () => {
            if (panel.classList.contains('collapsed')) btn.textContent = 'Show ●';
        };
    })();

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
    /**
     * Zurueck ins Menue. Wichtig: den gespeicherten Platz loeschen, sonst
     * meldet uns `tryReconnect` nach dem Neuladen sofort wieder in derselben
     * Partie an — und es sieht aus, als haette der Knopf nichts getan.
     * Eine laufende Partie wird dabei aufgegeben, damit der Gegner nicht
     * 30 Sekunden auf den Forfeit-Timer warten muss.
     */
    function leaveToMenu(askFirst) {
        const running = S.started && !S.over && S.roomCode;
        if (running && askFirst &&
            !confirm('Leave the game? This counts as a resignation.')) return;
        if (running) socket.emit('resign', { roomCode: S.roomCode });
        try { sessionStorage.removeItem('pred_seat'); } catch (e) { /* egal */ }
        // Kurz warten, damit das resign den Server noch erreicht.
        setTimeout(() => location.reload(), running ? 180 : 0);
    }

    $('btn-leave-lobby').addEventListener('click', () => leaveToMenu(false));
    $('btn-leave-game').addEventListener('click', () => leaveToMenu(true));
    $('btn-back-to-menu').addEventListener('click', () => leaveToMenu(false));

    const rulesModal = DomUtils.makeAccessibleModal
        ? DomUtils.makeAccessibleModal($('rules-modal'))
        : { open: () => { $('rules-modal').style.display = 'flex'; }, close: () => { $('rules-modal').style.display = 'none'; } };
    $('btn-show-rules').addEventListener('click', () => rulesModal.open());
    $('btn-menu-rules').addEventListener('click', () => rulesModal.open());
    $('close-rules-btn').addEventListener('click', () => rulesModal.close());

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') return cancelEverything();
        // Enter bestaetigt den Zug — aber nicht, wenn gerade ein Feld oder ein
        // anderer Knopf den Fokus hat, sonst feuert es doppelt.
        if (e.key === 'Enter' && S.arrow && awaitingCall()) {
            const t = e.target;
            if (t && t.closest && t.closest('.square, input, select')) return;
            if (t && t.id && t.id !== 'btn-send-turn' && t.tagName === 'BUTTON') return;
            e.preventDefault();
            commitTurn();
        }
    });
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

    // Zeichenpfeile zum Rechnen — nur waehrend der Gegner am Zug ist. In der
    // eigenen Zugphase gehoert der Rechtsklick dem Tipp, sonst kaeme man sich
    // gegenseitig ins Gehege.
    const boardAnnotations = BoardArrows.attach({
        board: '#board',
        enabled: () => S.started && !S.over && S.turn !== S.color
    });

    buildShop();
    resetChat();
    buildBoard();
    render();
    tickTimer();
    if (Sfx.mountFloatingToggle) Sfx.mountFloatingToggle();
})();
