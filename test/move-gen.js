/**
 * Isomorphe Zuggenerierung für CagersGameHub.
 *
 * Läuft identisch im Browser (als globales `MoveGen`) und in Node
 * (via `require('./public/shared/move-gen.js')`). Das ist der Kern der
 * Sicherheitsarchitektur: Client und Server benutzen exakt dieselbe
 * Funktion, dadurch kann der Server jeden Zug prüfen, ohne dass legale
 * Züge fälschlich abgelehnt werden.
 *
 * WICHTIG: Diese Datei darf keine DOM- oder Node-spezifischen APIs nutzen.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MoveGen = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

    /** Steht {r,c} in einer Feldliste? Toleriert null/undefined. */
    function squareInList(list, r, c) {
        if (!Array.isArray(list)) return false;
        for (const s of list) if (s && s.r === r && s.c === c) return true;
        return false;
    }

    /** Prüft, ob ein Wert ein gültiger Brett-Index ist (gegen manipulierte Clients). */
    function isValidIndex(v) {
        return Number.isInteger(v) && v >= 0 && v <= 7;
    }

    /** Prüft ein komplettes Koordinaten-Set. */
    function validCoords() {
        for (let i = 0; i < arguments.length; i++) {
            if (!isValidIndex(arguments[i])) return false;
        }
        return true;
    }

    // =====================================================================
    // KLASSISCH (Cagers Quick Chess) — Brett ist string|null pro Feld
    // =====================================================================

    const INITIAL_CHESS_BOARD = [
        ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
        ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
        ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
    ];

    function createInitialBoard() {
        return INITIAL_CHESS_BOARD.map(row => row.slice());
    }

    function colorOf(piece) {
        if (!piece) return null;
        return piece === piece.toUpperCase() ? 'w' : 'b';
    }

    function isEnemy(p1, p2) {
        if (!p1 || !p2) return false;
        return colorOf(p1) !== colorOf(p2);
    }

    /**
     * Zuggenerator für Quick Chess.
     * @param {Array} board            8x8, string|null
     * @param {number} r
     * @param {number} c
     * @param {object} [opts]
     * @param {object} [opts.enPassantTarget] {r,c,color}
     * @param {object} [opts.hasMoved]        {wK,wR_left,wR_right,bK,bR_left,bR_right}
     * @param {object} [opts.activeEffect]    {id} — Chaos-Modus-Effekte (optional)
     *
     * Prediction-Chess-Items (alle optional, Standard = aus):
     * @param {Array}  [opts.frozen]          [{r,c}] Figuren, die nicht ziehen dürfen (Shackle)
     * @param {Array}  [opts.blockedTargets]  [{r,c}] gesperrte Zielfelder (Minefield)
     * @param {object} [opts.extraPattern]    {r,c,type:'knight'} zusätzliche Gangart (Cavalry)
     * @param {boolean}[opts.pawnDoubleAnywhere] Bauern-Doppelschritt von jeder Reihe (Pawn Storm)
     * @param {boolean}[opts.noCapture]       keine Schlagzüge (zweiter Zug des Double Move)
     */
    function classicMoves(board, r, c, opts) {
        opts = opts || {};
        if (!validCoords(r, c) || !board || !board[r]) return [];

        const piece = board[r][c];
        if (!piece) return [];

        // Shackle: gefesselte Figur hat keine Züge. Sie deckt weiterhin Felder —
        // Angriffskarten werden davon bewusst nicht beeinflusst.
        if (squareInList(opts.frozen, r, c)) return [];

        const enPassantTarget = opts.enPassantTarget || null;
        const hasMoved = opts.hasMoved || null;
        const activeEffect = opts.activeEffect || null;

        const moves = [];
        const color = colorOf(piece);
        const dir = color === 'w' ? -1 : 1;
        const startRow = color === 'w' ? 6 : 1;
        const isIce = !!(activeEffect && activeEffect.id === 'ice');

        const addSliding = (dirs) => {
            for (const [dr, dc] of dirs) {
                let nr = r + dr, nc = c + dc;
                const rayMoves = [];
                while (inBounds(nr, nc)) {
                    if (!board[nr][nc]) {
                        rayMoves.push({ r: nr, c: nc, type: 'normal' });
                    } else {
                        if (isEnemy(piece, board[nr][nc])) rayMoves.push({ r: nr, c: nc, type: 'capture' });
                        break;
                    }
                    nr += dr; nc += dc;
                }
                if (isIce) {
                    if (rayMoves.length > 0) moves.push(rayMoves[rayMoves.length - 1]);
                } else {
                    moves.push(...rayMoves);
                }
            }
        };

        const addLeaper = (deltas) => {
            for (const [dr, dc] of deltas) {
                const nr = r + dr, nc = c + dc;
                if (!inBounds(nr, nc)) continue;
                if (!board[nr][nc]) moves.push({ r: nr, c: nc, type: 'normal' });
                else if (isEnemy(piece, board[nr][nc])) moves.push({ r: nr, c: nc, type: 'capture' });
            }
        };

        const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

        switch (piece.toLowerCase()) {
            case 'p':
                if (activeEffect && activeEffect.id === 'pawn_jump') {
                    addLeaper(KNIGHT);
                } else {
                    const canSprint = !!(activeEffect && activeEffect.id === 'pawn_sprint') ||
                                      !!opts.pawnDoubleAnywhere;
                    if (inBounds(r + dir, c) && !board[r + dir][c]) {
                        moves.push({ r: r + dir, c, type: 'normal' });
                        if ((r === startRow || canSprint) && inBounds(r + dir * 2, c) && !board[r + dir * 2][c]) {
                            moves.push({ r: r + dir * 2, c, type: 'normal' });
                        }
                    }
                    for (const dc of [-1, 1]) {
                        const tr = r + dir, tc = c + dc;
                        if (!inBounds(tr, tc)) continue;
                        if (board[tr][tc] && isEnemy(piece, board[tr][tc])) {
                            moves.push({ r: tr, c: tc, type: 'capture' });
                        } else if (enPassantTarget && enPassantTarget.color !== color &&
                                   enPassantTarget.r === tr && enPassantTarget.c === tc) {
                            moves.push({ r: tr, c: tc, type: 'en_passant' });
                        }
                    }
                }
                break;

            case 'r': addSliding([[-1, 0], [1, 0], [0, -1], [0, 1]]); break;
            case 'b': addSliding([[-1, -1], [-1, 1], [1, -1], [1, 1]]); break;
            case 'q': addSliding([[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]); break;
            case 'n': addLeaper(KNIGHT); break;

            case 'k': {
                const maxDist = (activeEffect && activeEffect.id === 'royal_guard') ? 2 : 1;
                const deltas = [];
                for (let dr = -maxDist; dr <= maxDist; dr++) {
                    for (let dc = -maxDist; dc <= maxDist; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        deltas.push([dr, dc]);
                    }
                }
                addLeaper(deltas);

                const kRow = color === 'w' ? 7 : 0;
                const kKey = color === 'w' ? 'wK' : 'bK';
                const rookChar = color === 'w' ? 'R' : 'r';
                if (hasMoved && r === kRow && c === 4 && !hasMoved[kKey]) {
                    const rRight = color === 'w' ? 'wR_right' : 'bR_right';
                    if (!hasMoved[rRight] && board[kRow][7] === rookChar &&
                        !board[kRow][5] && !board[kRow][6]) {
                        moves.push({ r: kRow, c: 6, type: 'castle' });
                    }
                    const rLeft = color === 'w' ? 'wR_left' : 'bR_left';
                    if (!hasMoved[rLeft] && board[kRow][0] === rookChar &&
                        !board[kRow][1] && !board[kRow][2] && !board[kRow][3]) {
                        moves.push({ r: kRow, c: 2, type: 'castle' });
                    }
                }
                break;
            }
        }

        // --- Prediction-Chess-Items ---------------------------------------

        // Cavalry: gewählte Figur zieht zusätzlich wie ein Springer.
        const ep = opts.extraPattern;
        if (ep && ep.r === r && ep.c === c && ep.type === 'knight') {
            addLeaper(KNIGHT);
        }

        let out = moves;

        // Doppelte Ziele entfernen (Cavalry auf einem Springer o. Ä.).
        if (ep && ep.r === r && ep.c === c) {
            const seen = Object.create(null);
            out = out.filter(m => {
                const key = m.r + ',' + m.c;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });
        }

        // Minefield: gesperrte Zielfelder herausfiltern.
        if (Array.isArray(opts.blockedTargets) && opts.blockedTargets.length) {
            out = out.filter(m => !squareInList(opts.blockedTargets, m.r, m.c));
        }

        // Double Move, zweiter Zug: nichts schlagen.
        if (opts.noCapture) {
            out = out.filter(m => m.type !== 'capture' && m.type !== 'en_passant');
        }

        return out;
    }

    /** Aktualisiert die Rochade-Rechte nach einem Zug (mutiert `hasMoved`). */
    function updateCastlingRights(hasMoved, piece, fromR, fromC, toR, toC, board) {
        if (!hasMoved || !piece) return hasMoved;
        const p = typeof piece === 'string' ? piece : '';
        if (p === 'K') hasMoved.wK = true;
        if (p === 'k') hasMoved.bK = true;
        if (p === 'R' && fromR === 7 && fromC === 0) hasMoved.wR_left = true;
        if (p === 'R' && fromR === 7 && fromC === 7) hasMoved.wR_right = true;
        if (p === 'r' && fromR === 0 && fromC === 0) hasMoved.bR_left = true;
        if (p === 'r' && fromR === 0 && fromC === 7) hasMoved.bR_right = true;
        // Ein geschlagener Turm verliert das Recht ebenfalls.
        if (toR === 7 && toC === 0) hasMoved.wR_left = true;
        if (toR === 7 && toC === 7) hasMoved.wR_right = true;
        if (toR === 0 && toC === 0) hasMoved.bR_left = true;
        if (toR === 0 && toC === 7) hasMoved.bR_right = true;
        return hasMoved;
    }

    function createHasMoved() {
        return { wK: false, wR_left: false, wR_right: false, bK: false, bR_left: false, bR_right: false };
    }

    // =====================================================================
    // MUTANT MERGE CHESS — Brett ist string[]|null pro Feld
    // =====================================================================

    const PIECE_RANK = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

    function createInitialMutantBoard() {
        return [
            [['r'], ['n'], ['b'], ['q'], ['k'], ['b'], ['n'], ['r']],
            [['p'], ['p'], ['p'], ['p'], ['p'], ['p'], ['p'], ['p']],
            [null, null, null, null, null, null, null, null],
            [null, null, null, null, null, null, null, null],
            [null, null, null, null, null, null, null, null],
            [null, null, null, null, null, null, null, null],
            [['P'], ['P'], ['P'], ['P'], ['P'], ['P'], ['P'], ['P']],
            [['R'], ['N'], ['B'], ['Q'], ['K'], ['B'], ['N'], ['R']]
        ];
    }

    function getPieceColor(pieceArr) {
        if (!pieceArr || !pieceArr.length || typeof pieceArr[0] !== 'string' || !pieceArr[0].length) return null;
        return pieceArr[0][0] === pieceArr[0][0].toUpperCase() ? 'w' : 'b';
    }

    function baseChar(p) {
        return p.toLowerCase().replace('_fused', '');
    }

    function sortCanonically(pieceArr) {
        if (!pieceArr) return pieceArr;
        return pieceArr.slice().sort((a, b) => (PIECE_RANK[baseChar(a)] || 5) - (PIECE_RANK[baseChar(b)] || 5));
    }

    /**
     * Einzige Quelle der Wahrheit für Fusions-Legalität.
     * Wird von Client (Zug-Highlighting) und Server (Validierung) benutzt.
     * @returns {{ok: boolean, reason?: string}}
     */
    function checkMergeLegality(movingPiece, targetPiece, allowKingFusion, fusionsLeftForColor) {
        if (!movingPiece || !targetPiece) return { ok: false, reason: 'Invalid merge target!' };
        if (movingPiece.some(p => p.includes('_fused')) || targetPiece.some(p => p.includes('_fused'))) {
            return { ok: false, reason: 'Fused piece cannot be fused again!' };
        }
        if (movingPiece.length + targetPiece.length > 2) {
            return { ok: false, reason: 'Max 2 pieces per square!' };
        }
        const combined = [...movingPiece, ...targetPiece].map(baseChar);
        if (new Set(combined).size !== combined.length) {
            return { ok: false, reason: 'Cannot merge identical pieces!' };
        }
        if (combined.includes('q') && (combined.includes('b') || combined.includes('r'))) {
            return { ok: false, reason: 'Queen already moves like Bishop and Rook!' };
        }
        if (combined.includes('q') && combined.includes('p')) {
            return { ok: false, reason: 'Queen cannot merge with Pawn!' };
        }
        if (combined.includes('k') && combined.includes('p')) {
            return { ok: false, reason: 'King cannot merge with Pawn!' };
        }
        if (combined.includes('k') && !allowKingFusion) {
            return { ok: false, reason: 'King fusions are disabled in this room!' };
        }
        if (fusionsLeftForColor !== undefined && fusionsLeftForColor <= 0) {
            return { ok: false, reason: 'No fusions remaining!' };
        }
        return { ok: true };
    }

    /**
     * Zuggenerator für Mutant Merge Chess.
     * @param {Array} board 8x8, string[]|null
     * @param {object} [opts]
     * @param {object} [opts.enPassantTarget]
     * @param {object} [opts.hasMoved]
     * @param {boolean} [opts.allowKingFusion]
     * @param {object} [opts.fusionsLeft] {w,b}
     */
    function mutantMoves(board, r, c, opts) {
        opts = opts || {};
        if (!validCoords(r, c) || !board || !board[r]) return [];

        const pieceArr = board[r][c];
        if (!pieceArr || !pieceArr.length) return [];

        const pColor = getPieceColor(pieceArr);
        if (!pColor) return [];

        const enPassantTarget = opts.enPassantTarget || null;
        const hasMoved = opts.hasMoved || null;
        const allowKingFusion = opts.allowKingFusion !== undefined ? opts.allowKingFusion : true;
        const fusionsLeft = opts.fusionsLeft || {};
        const remaining = fusionsLeft[pColor] !== undefined ? fusionsLeft[pColor] : 0;

        const moves = [];
        const canMerge = remaining > 0;
        const isPieceFused = pieceArr.some(p => p.includes('_fused'));

        const tryMerge = (nr, nc, target) => {
            if (!canMerge || isPieceFused) return;
            const res = checkMergeLegality(pieceArr, target, allowKingFusion, remaining);
            if (res.ok) moves.push({ r: nr, c: nc, type: 'merge' });
        };

        const handleOccupied = (nr, nc, target) => {
            if (getPieceColor(target) !== pColor) moves.push({ r: nr, c: nc, type: 'capture' });
            else tryMerge(nr, nc, target);
        };

        pieceArr.forEach(typeChar => {
            const charLower = baseChar(typeChar);
            const dir = pColor === 'w' ? -1 : 1;
            const startRow = pColor === 'w' ? 6 : 1;

            const addSliding = (dirs) => {
                for (const [dr, dc] of dirs) {
                    let nr = r + dr, nc = c + dc;
                    while (inBounds(nr, nc)) {
                        const target = board[nr][nc];
                        if (!target) {
                            moves.push({ r: nr, c: nc, type: 'normal' });
                        } else {
                            handleOccupied(nr, nc, target);
                            break;
                        }
                        nr += dr; nc += dc;
                    }
                }
            };

            const addLeaper = (deltas) => {
                for (const [dr, dc] of deltas) {
                    const nr = r + dr, nc = c + dc;
                    if (!inBounds(nr, nc)) continue;
                    const target = board[nr][nc];
                    if (!target) moves.push({ r: nr, c: nc, type: 'normal' });
                    else handleOccupied(nr, nc, target);
                }
            };

            switch (charLower) {
                case 'p':
                    if (inBounds(r + dir, c) && !board[r + dir][c]) {
                        moves.push({ r: r + dir, c, type: 'normal' });
                        if (r === startRow && inBounds(r + dir * 2, c) && !board[r + dir * 2][c]) {
                            moves.push({ r: r + dir * 2, c, type: 'normal' });
                        }
                    }
                    for (const dc of [-1, 1]) {
                        const tr = r + dir, tc = c + dc;
                        if (!inBounds(tr, tc)) continue;
                        const target = board[tr][tc];
                        if (target) {
                            handleOccupied(tr, tc, target);
                        } else if (enPassantTarget && enPassantTarget.color !== pColor &&
                                   enPassantTarget.r === tr && enPassantTarget.c === tc) {
                            moves.push({ r: tr, c: tc, type: 'en_passant' });
                        }
                    }
                    break;

                case 'r': addSliding([[-1, 0], [1, 0], [0, -1], [0, 1]]); break;
                case 'b': addSliding([[-1, -1], [-1, 1], [1, -1], [1, 1]]); break;
                case 'q': addSliding([[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]); break;
                case 'n': addLeaper([[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]); break;

                case 'k': {
                    addLeaper([[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]);

                    const kRow = pColor === 'w' ? 7 : 0;
                    const kKey = pColor === 'w' ? 'wK' : 'bK';
                    const rookChar = pColor === 'w' ? 'R' : 'r';
                    if (hasMoved && r === kRow && c === 4 && !hasMoved[kKey]) {
                        const rRight = pColor === 'w' ? 'wR_right' : 'bR_right';
                        if (!hasMoved[rRight] && board[kRow][7] && board[kRow][7].includes(rookChar) &&
                            !board[kRow][5] && !board[kRow][6]) {
                            moves.push({ r: kRow, c: 6, type: 'castle' });
                        }
                        const rLeft = pColor === 'w' ? 'wR_left' : 'bR_left';
                        if (!hasMoved[rLeft] && board[kRow][0] && board[kRow][0].includes(rookChar) &&
                            !board[kRow][1] && !board[kRow][2] && !board[kRow][3]) {
                            moves.push({ r: kRow, c: 2, type: 'castle' });
                        }
                    }
                    break;
                }
            }
        });

        // Pro Zielfeld nur einen Eintrag (eine Mutantenfigur kann dasselbe Feld
        // über mehrere Gangarten erreichen).
        const uniqueMap = new Map();
        moves.forEach(m => uniqueMap.set(m.r + '-' + m.c, m));
        return Array.from(uniqueMap.values());
    }

    /** Rochade-Rechte für Mutant (Figuren sind Arrays). */
    function updateMutantCastlingRights(hasMoved, movingPiece, fromR, fromC, toR, toC) {
        if (!hasMoved || !movingPiece) return hasMoved;
        if (movingPiece.includes('K')) hasMoved.wK = true;
        if (movingPiece.includes('k')) hasMoved.bK = true;
        if (movingPiece.includes('R') && fromR === 7 && fromC === 0) hasMoved.wR_left = true;
        if (movingPiece.includes('R') && fromR === 7 && fromC === 7) hasMoved.wR_right = true;
        if (movingPiece.includes('r') && fromR === 0 && fromC === 0) hasMoved.bR_left = true;
        if (movingPiece.includes('r') && fromR === 0 && fromC === 7) hasMoved.bR_right = true;
        if (toR === 7 && toC === 0) hasMoved.wR_left = true;
        if (toR === 7 && toC === 7) hasMoved.wR_right = true;
        if (toR === 0 && toC === 0) hasMoved.bR_left = true;
        if (toR === 0 && toC === 7) hasMoved.bR_right = true;
        return hasMoved;
    }

    // =====================================================================
    // KLASSISCHE REGELN MIT SCHACH — für Prediction Chess
    //
    // Quick Chess kennt kein Schach (dort gewinnt, wer den König schlägt),
    // deshalb filtert `classicMoves` nicht auf Königssicherheit. Prediction
    // Chess ist normales Schach, also liegt die komplette Legalitätsprüfung
    // hier — und zwar isomorph, damit Server und Client dasselbe rechnen.
    // =====================================================================

    const KNIGHT_DELTAS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

    /** Findet den König einer Farbe. */
    function findKing(board, color) {
        const target = color === 'w' ? 'K' : 'k';
        for (let r = 0; r < 8; r++) {
            if (!board[r]) continue;
            for (let c = 0; c < 8; c++) {
                if (board[r][c] === target) return { r, c };
            }
        }
        return null;
    }

    /**
     * Wird ein Feld von `byColor` angegriffen?
     *
     * Bewusst eigenständig statt über `classicMoves`: ein Bauer schlägt nur
     * diagonal, zieht aber gerade. Shackle und Minefield werden hier absichtlich
     * NICHT berücksichtigt — eine gefesselte Figur gibt weiterhin Schach, und ein
     * vermintes Feld schützt den König nicht. Das hält die Regeln vorhersehbar.
     *
     * @param {object} [opts.extraPattern] {r,c,type:'knight'} — Cavalry greift mit
     */
    function isSquareAttacked(board, r, c, byColor, opts) {
        opts = opts || {};
        if (!validCoords(r, c) || !board) return false;
        const ep = opts.extraPattern;
        const hasExtraKnight = (pr, pc) => !!(ep && ep.type === 'knight' && ep.r === pr && ep.c === pc);

        // Springer (inkl. Cavalry-Trägern)
        for (const [dr, dc] of KNIGHT_DELTAS) {
            const nr = r + dr, nc = c + dc;
            if (!inBounds(nr, nc)) continue;
            const p = board[nr][nc];
            if (!p || colorOf(p) !== byColor) continue;
            if (p.toLowerCase() === 'n' || hasExtraKnight(nr, nc)) return true;
        }

        // Bauern — nur diagonal, und zwar aus Sicht des Angreifers
        const pawnDir = byColor === 'w' ? 1 : -1; // von (r,c) aus rückwärts gedacht
        for (const dc of [-1, 1]) {
            const nr = r + pawnDir, nc = c + dc;
            if (!inBounds(nr, nc)) continue;
            const p = board[nr][nc];
            if (p && colorOf(p) === byColor && p.toLowerCase() === 'p') return true;
        }

        // König
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const nr = r + dr, nc = c + dc;
                if (!inBounds(nr, nc)) continue;
                const p = board[nr][nc];
                if (p && colorOf(p) === byColor && p.toLowerCase() === 'k') return true;
            }
        }

        // Turm/Dame und Läufer/Dame
        const rays = [
            { dirs: ROOK_DIRS, chars: ['r', 'q'] },
            { dirs: BISHOP_DIRS, chars: ['b', 'q'] }
        ];
        for (const ray of rays) {
            for (const [dr, dc] of ray.dirs) {
                let nr = r + dr, nc = c + dc;
                while (inBounds(nr, nc)) {
                    const p = board[nr][nc];
                    if (p) {
                        if (colorOf(p) === byColor && ray.chars.indexOf(p.toLowerCase()) !== -1) return true;
                        break;
                    }
                    nr += dr; nc += dc;
                }
            }
        }
        return false;
    }

    /** Steht die Farbe im Schach? */
    function isInCheck(board, color, opts) {
        const k = findKing(board, color);
        if (!k) return false;
        return isSquareAttacked(board, k.r, k.c, color === 'w' ? 'b' : 'w', opts);
    }

    /**
     * Führt einen Zug auf einer Kopie des Bretts aus.
     * Kennt Rochade, En Passant und Umwandlung.
     *
     * @returns {{board, captured: string|null, enPassantTarget: object|null,
     *            type: string, promotedTo: string|null, rook: object|null}}
     */
    function applyClassicMove(board, move, opts) {
        opts = opts || {};
        const next = board.map(row => row.slice());
        const { fromR, fromC, toR, toC } = move;
        const piece = next[fromR][fromC];
        const color = colorOf(piece);
        const lower = piece ? piece.toLowerCase() : '';
        const epT = opts.enPassantTarget || null;

        let type = move.type || 'normal';
        if (!move.type) {
            if (lower === 'k' && Math.abs(toC - fromC) === 2) type = 'castle';
            else if (lower === 'p' && toC !== fromC && !next[toR][toC] &&
                     epT && epT.r === toR && epT.c === toC && epT.color !== color) type = 'en_passant';
            else if (next[toR][toC]) type = 'capture';
        }

        let captured = null;
        let rook = null;

        if (type === 'en_passant') {
            const capR = color === 'w' ? toR + 1 : toR - 1;
            captured = next[capR][toC];
            next[capR][toC] = null;
        } else if (next[toR][toC]) {
            captured = next[toR][toC];
        }

        next[toR][toC] = piece;
        next[fromR][fromC] = null;

        if (type === 'castle') {
            const row = fromR;
            if (toC === 6) {           // kurz
                rook = { fromR: row, fromC: 7, toR: row, toC: 5 };
                next[row][5] = next[row][7];
                next[row][7] = null;
            } else if (toC === 2) {    // lang
                rook = { fromR: row, fromC: 0, toR: row, toC: 3 };
                next[row][3] = next[row][0];
                next[row][0] = null;
            }
        }

        // Umwandlung — der Server setzt promotedTo, nie der Client.
        let promotedTo = null;
        if (lower === 'p' && (toR === 0 || toR === 7)) {
            const want = typeof move.promotedTo === 'string' ? move.promotedTo.toLowerCase() : 'q';
            const safe = ['q', 'r', 'n', 'b'].indexOf(want) !== -1 ? want : 'q';
            promotedTo = color === 'w' ? safe.toUpperCase() : safe;
            next[toR][toC] = promotedTo;
        }

        // Neues En-Passant-Ziel nur nach einem Doppelschritt.
        let enPassantTarget = null;
        if (lower === 'p' && Math.abs(toR - fromR) === 2 && !opts.suppressEnPassant) {
            enPassantTarget = { r: (fromR + toR) / 2, c: fromC, color };
        }

        return { board: next, captured, enPassantTarget, type, promotedTo, rook };
    }

    /**
     * Legale Züge einer Figur: pseudo-legale Züge, gefiltert auf Königssicherheit.
     * Nimmt dieselben Item-`opts` wie `classicMoves` und zusätzlich:
     * @param {boolean} [opts.noCheck] der Zug darf kein Schach geben
     *                                 (zweiter Zug des Double Move)
     */
    function legalMoves(board, r, c, opts) {
        opts = opts || {};
        const piece = board && board[r] ? board[r][c] : null;
        if (!piece) return [];
        const color = colorOf(piece);
        const enemy = color === 'w' ? 'b' : 'w';
        const pseudo = classicMoves(board, r, c, opts);
        if (!pseudo.length) return [];

        const inCheckNow = isInCheck(board, color, opts);

        return pseudo.filter(m => {
            // Den König schlägt man nicht — in einer legalen Stellung kann das
            // ohnehin nie vorkommen, aber ein manipuliertes Brett soll hier
            // nicht plötzlich einen "Sieg-Zug" erzeugen.
            const victim = board[m.r] ? board[m.r][m.c] : null;
            if (victim && victim.toLowerCase() === 'k') return false;

            if (m.type === 'castle') {
                // Aus dem Schach heraus und durch ein bedrohtes Feld gibt es keine Rochade.
                if (inCheckNow) return false;
                const transit = m.c === 6 ? 5 : 3;
                if (isSquareAttacked(board, r, transit, enemy, opts)) return false;
            }
            const sim = applyClassicMove(board, {
                fromR: r, fromC: c, toR: m.r, toC: m.c, type: m.type
            }, opts);
            if (isInCheck(sim.board, color, opts)) return false;
            if (opts.noCheck && isInCheck(sim.board, enemy, opts)) return false;
            return true;
        });
    }

    /** Alle legalen Züge einer Farbe: [{fromR,fromC,toR,toC,type}]. */
    function allLegalMoves(board, color, opts) {
        const out = [];
        for (let r = 0; r < 8; r++) {
            if (!board[r]) continue;
            for (let c = 0; c < 8; c++) {
                const p = board[r][c];
                if (!p || colorOf(p) !== color) continue;
                for (const m of legalMoves(board, r, c, opts)) {
                    out.push({ fromR: r, fromC: c, toR: m.r, toC: m.c, type: m.type });
                }
            }
        }
        return out;
    }

    /** Gibt es überhaupt einen legalen Zug? Bricht beim ersten Treffer ab. */
    function hasAnyLegalMove(board, color, opts) {
        for (let r = 0; r < 8; r++) {
            if (!board[r]) continue;
            for (let c = 0; c < 8; c++) {
                const p = board[r][c];
                if (!p || colorOf(p) !== color) continue;
                if (legalMoves(board, r, c, opts).length) return true;
            }
        }
        return false;
    }

    /**
     * Status für die Seite, die am Zug ist.
     * @returns {'checkmate'|'stalemate'|'check'|'normal'}
     */
    function gameStatus(board, color, opts) {
        const check = isInCheck(board, color, opts);
        const canMove = hasAnyLegalMove(board, color, opts);
        if (!canMove) return check ? 'checkmate' : 'stalemate';
        return check ? 'check' : 'normal';
    }

    /**
     * Sichtfeld einer Farbe für Fog of War: eigene Felder plus alles, was die
     * eigenen Figuren erreichen oder angreifen. Bauern sehen zusätzlich ihre
     * Schlagdiagonalen, auch wenn dort gerade nichts steht.
     *
     * @returns {Array<{r:number,c:number}>}
     */
    function visibleSquares(board, color, opts) {
        opts = opts || {};
        const seen = Object.create(null);
        const mark = (r, c) => { if (inBounds(r, c)) seen[r + ',' + c] = true; };

        for (let r = 0; r < 8; r++) {
            if (!board[r]) continue;
            for (let c = 0; c < 8; c++) {
                const p = board[r][c];
                if (!p || colorOf(p) !== color) continue;
                mark(r, c);
                // Gefesselte Figuren sehen trotzdem — Shackle nimmt Züge, nicht Augen.
                const moveOpts = Object.assign({}, opts, { frozen: null, blockedTargets: null, noCapture: false });
                for (const m of classicMoves(board, r, c, moveOpts)) mark(m.r, m.c);
                if (p.toLowerCase() === 'p') {
                    const dir = color === 'w' ? -1 : 1;
                    mark(r + dir, c - 1);
                    mark(r + dir, c + 1);
                }
            }
        }
        return Object.keys(seen).map(k => {
            const parts = k.split(',');
            return { r: parseInt(parts[0], 10), c: parseInt(parts[1], 10) };
        });
    }

    return {
        // Allgemein
        inBounds, isValidIndex, validCoords, createHasMoved, squareInList,
        // Klassisch
        INITIAL_CHESS_BOARD, createInitialBoard, colorOf, isEnemy,
        classicMoves, updateCastlingRights,
        // Klassisch mit Schachregeln (Prediction Chess)
        findKing, isSquareAttacked, isInCheck, applyClassicMove,
        legalMoves, allLegalMoves, hasAnyLegalMove, gameStatus, visibleSquares,
        // Mutant
        PIECE_RANK, createInitialMutantBoard, getPieceColor, baseChar,
        sortCanonically, checkMergeLegality, mutantMoves, updateMutantCastlingRights
    };
});
