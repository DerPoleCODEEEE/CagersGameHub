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
     */
    function classicMoves(board, r, c, opts) {
        opts = opts || {};
        if (!validCoords(r, c) || !board || !board[r]) return [];

        const piece = board[r][c];
        if (!piece) return [];

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
                    const canSprint = !!(activeEffect && activeEffect.id === 'pawn_sprint');
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
        return moves;
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

    return {
        // Allgemein
        inBounds, isValidIndex, validCoords, createHasMoved,
        // Klassisch
        INITIAL_CHESS_BOARD, createInitialBoard, colorOf, isEnemy,
        classicMoves, updateCastlingRights,
        // Mutant
        PIECE_RANK, createInitialMutantBoard, getPieceColor, baseChar,
        sortCanonically, checkMergeLegality, mutantMoves, updateMutantCastlingRights
    };
});
