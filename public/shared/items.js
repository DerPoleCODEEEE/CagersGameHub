/**
 * Item-Registry für Prediction Chess.
 *
 * Isomorph: läuft identisch im Browser (global `Items`) und in Node
 * (`require('./public/shared/items.js')`). Server und Client lesen dieselben
 * Preise, Dauern, Zielregeln und Texte — es gibt keine zweite Wahrheit.
 *
 * Alle sichtbaren Texte sind Englisch (wie die übrigen Spielmodi).
 * WICHTIG: keine DOM- und keine Node-APIs in dieser Datei.
 */
(function (root, factory) {
    const MG = (typeof module === 'object' && module.exports)
        ? require('./move-gen.js')
        : root.MoveGen;
    const api = factory(MG);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Items = api;
})(typeof self !== 'undefined' ? self : this, function (MoveGen) {
    'use strict';

    const colorOf = MoveGen.colorOf;
    const inBounds = MoveGen.inBounds;

    // =====================================================================
    // Brett-Hilfen
    // =====================================================================

    /** Eigene Bretthälfte: Weiß r4..r7, Schwarz r0..r3. */
    function isOwnHalf(color, r) {
        return color === 'w' ? (r >= 4 && r <= 7) : (r >= 0 && r <= 3);
    }

    /** Grundreihe der Farbe. */
    function backRank(color) {
        return color === 'w' ? 7 : 0;
    }

    function pieceAt(board, r, c) {
        if (!inBounds(r, c) || !board || !board[r]) return null;
        return board[r][c] || null;
    }

    /** Filtert die Schlagliste auf gültige Figurenbuchstaben (kein König). */
    function normalizeCaptured(list) {
        if (!Array.isArray(list)) return [];
        return list.filter(p => typeof p === 'string' && /^[pnbrqPNBRQ]$/.test(p));
    }

    // =====================================================================
    // Zielarten
    // =====================================================================
    //
    // Jedes Item beschreibt seine Ziele als Liste von "Slots". Der Client
    // baut daraus den Zielmodus (welche Felder leuchten), der Server prüft
    // exakt dieselben Regeln noch einmal nach.
    //
    //   ownPiece       eine eigene Figur auf dem Brett
    //   enemyPiece     eine gegnerische Figur
    //   emptySquare    ein leeres Feld (beliebig)
    //   ownHalfEmpty   ein leeres Feld in der eigenen Bretthälfte
    //   capturedPiece  Auswahl aus den eigenen geschlagenen Figuren (kein Feld)

    const TARGET_KINDS = ['ownPiece', 'enemyPiece', 'emptySquare', 'ownHalfEmpty', 'capturedPiece'];

    // =====================================================================
    // Die Items
    // =====================================================================
    //
    // tick:  wann die Restdauer heruntergezählt wird
    //          'ownMove'   nach jedem eigenen Zug
    //          'enemyMove' nach jedem gegnerischen Zug
    //          'anyMove'   nach jedem Halbzug (beide Seiten)
    //          null        kein Zeitablauf (sofort oder verbrauchsbasiert)
    // charges: verbrauchsbasierte Effekte (Treffer, Tipps, Käufe)

    const ITEMS = {

        // ---- A — Tempo & Movement ----------------------------------------
        pawn_storm: {
            id: 'pawn_storm',
            icon: '♟️',
            name: 'Pawn Storm',
            price: 2,
            category: 'tempo',
            targets: [],
            tick: 'ownMove',
            duration: 3,
            short: 'For 3 turns your pawns may advance two squares from any rank.',
            rules: 'For your next 3 turns, every one of your pawns may push two squares forward ' +
                   'from any rank. They still cannot jump over pieces, and these double steps ' +
                   'cannot be answered with en passant.'
        },

        swap: {
            id: 'swap',
            icon: '♻️',
            name: 'Swap Places',
            price: 3,
            category: 'tempo',
            targets: [
                { kind: 'ownPiece', label: 'First piece' },
                { kind: 'ownPiece', label: 'Second piece' }
            ],
            tick: null,
            duration: 0,
            short: 'Swap the squares of two of your own pieces.',
            rules: 'Two of your pieces trade places. The resulting position must be legal — you ' +
                   'may not put yourself in check. Swapping king and rook is an artificial castle ' +
                   'and works even if you lost your castling rights long ago.'
        },

        cavalry: {
            id: 'cavalry',
            icon: '🐴',
            name: 'Cavalry',
            price: 3,
            category: 'tempo',
            targets: [
                { kind: 'ownPiece', filter: 'notKing', label: 'Piece to mount' }
            ],
            tick: 'ownMove',
            duration: 2,
            short: 'One of your pieces also moves like a knight for 2 turns.',
            rules: 'The chosen piece keeps its normal moves and may additionally move like a ' +
                   'knight, leaping over anything in the way. Lasts for 2 of your turns. ' +
                   'The king cannot be chosen.'
        },

        double_move: {
            id: 'double_move',
            icon: '⏩',
            name: 'Double Move',
            price: 6,
            category: 'tempo',
            targets: [],
            tick: null,
            duration: 0,
            grantsExtraMove: true,
            short: 'Two moves in a row. The second may not capture or give check.',
            rules: 'After your next move you immediately move again. That second move may not ' +
                   'capture anything and may not put the enemy king in check. It is a pure tempo ' +
                   'item: build an attack, walk your king to safety, regroup.'
        },

        // ---- B — Disruption ----------------------------------------------
        no_castling: {
            id: 'no_castling',
            icon: '🚫',
            name: 'Castling Ban',
            price: 2,
            category: 'disrupt',
            targets: [],
            tick: null,
            duration: 0,
            permanent: true,
            short: 'Your opponent permanently loses the right to castle.',
            rules: 'For the rest of the game your opponent cannot castle — neither side. If they ' +
                   'have already castled the purchase would do nothing, so the server refuses it.'
        },

        dispel: {
            id: 'dispel',
            icon: '✨',
            name: 'Dispel',
            price: 2,
            category: 'disrupt',
            targets: [],
            tick: null,
            duration: 0,
            short: 'Ends every active enemy effect at once.',
            rules: 'Every running enemy effect ends immediately — Shackle, Minefield, Cavalry, ' +
                   'Pawn Storm, a pending Double Move, even Fog of War. Permanent effects such as ' +
                   'the Castling Ban stay in place.'
        },

        freeze: {
            id: 'freeze',
            icon: '🔗',
            name: 'Shackle',
            price: 3,
            category: 'disrupt',
            targets: [
                { kind: 'enemyPiece', filter: 'notKing', label: 'Enemy piece' }
            ],
            tick: 'enemyMove',
            duration: 2,
            notWhileEnemyInCheck: true,
            short: 'One enemy piece cannot move for 2 of their turns.',
            rules: 'The chosen piece is stuck for 2 enemy turns. It can still be captured and it ' +
                   'still guards squares. The king cannot be shackled, and the item is locked ' +
                   'while your opponent is in check.'
        },

        minefield: {
            id: 'minefield',
            icon: '💣',
            name: 'Minefield',
            price: 4,
            category: 'disrupt',
            targets: [
                { kind: 'emptySquare', label: 'First square' },
                { kind: 'emptySquare', label: 'Second square' }
            ],
            tick: 'enemyMove',
            duration: 3,
            short: 'Two empty squares are sealed off for 3 enemy turns.',
            rules: 'No enemy piece may land on the two marked squares for 3 turns — useful to cut ' +
                   'off escape squares or finish a mating net. The server rejects a placement that ' +
                   'would leave your opponent with no legal move at all.'
        },

        // ---- C — Material -------------------------------------------------
        recruit: {
            id: 'recruit',
            icon: '🪖',
            name: 'Recruit',
            price: 3,
            category: 'material',
            targets: [
                { kind: 'ownHalfEmpty', filter: 'notBackRank', label: 'Square for the pawn' }
            ],
            tick: null,
            duration: 0,
            short: 'Place an extra pawn in your own half.',
            rules: 'An extra pawn appears on an empty square in your half of the board, never on ' +
                   'your back rank. From then on it behaves like any other pawn and can promote.'
        },

        resurrect: {
            id: 'resurrect',
            icon: '🕯️',
            name: 'Revival',
            price: 5,
            category: 'material',
            targets: [
                { kind: 'capturedPiece', label: 'Captured piece' },
                { kind: 'ownHalfEmpty', label: 'Square' }
            ],
            tick: null,
            duration: 0,
            short: 'Bring one of your captured pieces back onto the board.',
            rules: 'Pick one of your captured pieces and an empty square in your half. It may not ' +
                   'give check the moment it lands — otherwise this would be a placement trick ' +
                   'rather than a comeback. Pawns cannot return to your back rank.'
        },

        upgrade: {
            id: 'upgrade',
            icon: '⬆️',
            name: 'Upgrade',
            price: 6,
            category: 'material',
            targets: [
                { kind: 'ownPiece', filter: 'upgradable', label: 'Piece to upgrade' }
            ],
            tick: null,
            duration: 0,
            permanent: true,
            short: 'One of your pieces permanently moves up a tier.',
            rules: 'Pawn becomes a knight or a bishop (your choice), knight and bishop become a ' +
                   'rook, a rook becomes a queen. The upgrade is permanent. Kings and queens ' +
                   'cannot be upgraded.'
        },

        // ---- E — Prediction & Meta ----------------------------------------
        second_guess: {
            id: 'second_guess',
            icon: '🎯',
            name: 'Second Guess',
            price: 1,
            category: 'meta',
            targets: [],
            tick: null,
            charges: 1,
            short: 'Draw two arrows on your next prediction.',
            rules: 'For exactly one prediction you may name two different moves. If either one ' +
                   'lands, it counts as a hit and your streak keeps growing.'
        },

        streak_shield: {
            id: 'streak_shield',
            icon: '🛡️',
            name: 'Streak Shield',
            price: 2,
            category: 'meta',
            targets: [],
            tick: null,
            charges: 1,
            short: 'Your next miss does not reset your streak.',
            rules: 'One wrong prediction does not cost you your run — it simply carries on. Also ' +
                   'covers a turn where you skip the prediction entirely.'
        },

        double_coins: {
            id: 'double_coins',
            icon: '💰',
            name: 'Double Coins',
            price: 2,
            category: 'meta',
            targets: [],
            tick: null,
            charges: 4,
            short: 'Your next 4 hits pay double.',
            rules: 'Each of your next 4 correct predictions pays twice as much, applied after the ' +
                   'streak multiplier. It pays for itself from the second hit onwards.'
        },

        cloak: {
            id: 'cloak',
            icon: '🌫️',
            name: 'Cloak',
            price: 2,
            category: 'meta',
            targets: [],
            tick: null,
            charges: 1,
            short: 'Your next purchase stays nameless to your opponent.',
            rules: 'Your opponent only sees "item used" instead of the name, and the effect bar ' +
                   'shows a question mark. The effect itself still happens — they just do not ' +
                   'know which one yet.'
        },

        // ---- F — Vision ----------------------------------------------------
        fog: {
            id: 'fog',
            icon: '🌁',
            name: 'Fog of War',
            price: 6,
            category: 'vision',
            targets: [],
            tick: 'anyMove',
            duration: 8,
            symmetric: true,
            short: 'For 8 half-moves both sides only see their own line of sight.',
            rules: 'Both players only see squares their own pieces stand on or attack. The fog ' +
                   'hits you as well — but you know it is coming and can prepare. Predictions stay ' +
                   'allowed, they are just mostly guesswork: during these 8 half-moves almost ' +
                   'nobody earns coins.'
        }
    };

    const ITEM_LIST = Object.keys(ITEMS).map(k => ITEMS[k]);

    const CATEGORY_LABEL = {
        tempo: 'Tempo & Movement',
        disrupt: 'Disruption',
        material: 'Material',
        meta: 'Predictions',
        vision: 'Vision'
    };

    /** Reihenfolge im Shop: nach Kategorie, dann nach Preis. */
    const CATEGORY_ORDER = ['tempo', 'disrupt', 'material', 'meta', 'vision'];
    const SHOP_ORDER = ITEM_LIST.slice().sort((a, b) => {
        const ci = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
        return ci !== 0 ? ci : a.price - b.price;
    }).map(i => i.id);

    function getItem(id) {
        return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, id))
            ? ITEMS[id] : null;
    }

    // =====================================================================
    // Ökonomie
    // =====================================================================

    const STREAK_TIERS = [
        { at: 8, mult: 3 },
        { at: 5, mult: 2 },
        { at: 3, mult: 1.5 }
    ];

    /** Multiplikator für eine Streak-Länge (Länge NACH dem Treffer). */
    function streakMultiplier(streak) {
        for (const t of STREAK_TIERS) if (streak >= t.at) return t.mult;
        return 1;
    }

    /**
     * Münzen für einen Treffer.
     * @param {number} streak    Serienlänge nach diesem Treffer
     * @param {boolean} doubled  Double Coins aktiv
     */
    function coinsForHit(streak, doubled) {
        const base = Math.floor(1 * streakMultiplier(streak));
        return doubled ? base * 2 : base;
    }

    // =====================================================================
    // Zielprüfung — identisch auf Client und Server
    // =====================================================================

    const UPGRADE_PATH = { p: ['n', 'b'], n: ['r'], b: ['r'], r: ['q'] };

    /** Zu welchen Figuren kann `piece` aufgewertet werden? */
    function upgradeOptions(piece) {
        if (typeof piece !== 'string' || !piece) return [];
        return (UPGRADE_PATH[piece.toLowerCase()] || []).slice();
    }

    /**
     * Prüft einen einzelnen Ziel-Slot.
     * @returns {{ok: boolean, reason?: string}}  reason ist englischer UI-Text
     */
    function isValidTarget(slot, board, color, target, captured) {
        if (!slot) return { ok: false, reason: 'Unknown target.' };

        if (slot.kind === 'capturedPiece') {
            const list = normalizeCaptured(captured);
            const idx = target && target.index;
            if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
                return { ok: false, reason: 'That captured piece does not exist.' };
            }
            return { ok: true };
        }

        const r = target && target.r, c = target && target.c;
        if (!MoveGen.validCoords(r, c)) return { ok: false, reason: 'That square is off the board.' };
        const piece = pieceAt(board, r, c);

        switch (slot.kind) {
            case 'ownPiece': {
                if (!piece) return { ok: false, reason: 'There is no piece there.' };
                if (colorOf(piece) !== color) return { ok: false, reason: 'That is not your piece.' };
                if (slot.filter === 'notKing' && piece.toLowerCase() === 'k') {
                    return { ok: false, reason: 'The king cannot be chosen here.' };
                }
                if (slot.filter === 'upgradable' && upgradeOptions(piece).length === 0) {
                    return { ok: false, reason: 'That piece cannot be upgraded.' };
                }
                return { ok: true };
            }
            case 'enemyPiece': {
                if (!piece) return { ok: false, reason: 'There is no piece there.' };
                if (colorOf(piece) === color) return { ok: false, reason: 'That is your own piece.' };
                if (slot.filter === 'notKing' && piece.toLowerCase() === 'k') {
                    return { ok: false, reason: 'The king cannot be shackled.' };
                }
                return { ok: true };
            }
            case 'emptySquare': {
                if (piece) return { ok: false, reason: 'That square is occupied.' };
                return { ok: true };
            }
            case 'ownHalfEmpty': {
                if (piece) return { ok: false, reason: 'That square is occupied.' };
                if (!isOwnHalf(color, r)) return { ok: false, reason: 'Only in your own half of the board.' };
                if (slot.filter === 'notBackRank' && r === backRank(color)) {
                    return { ok: false, reason: 'Not on your back rank.' };
                }
                return { ok: true };
            }
            default:
                return { ok: false, reason: 'Unknown target type.' };
        }
    }

    /**
     * Alle Felder, die für einen Ziel-Slot in Frage kommen.
     * Der Client benutzt das für den Zielmodus (welche Felder leuchten).
     */
    function validTargetSquares(slot, board, color) {
        const out = [];
        if (!slot || slot.kind === 'capturedPiece') return out;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (isValidTarget(slot, board, color, { r, c }, []).ok) out.push({ r, c });
            }
        }
        return out;
    }

    /**
     * Kaufprüfung ohne Brettsimulation.
     * Die regelabhängigen Fälle (Selbstschach nach Swap, Patt durch Minefield,
     * Schach durch Revival) prüft der Server zusätzlich, weil dafür das Brett
     * verändert werden muss.
     *
     * @returns {{ok: boolean, reason?: string}}
     */
    function canBuy(itemId, ctx) {
        const item = getItem(itemId);
        if (!item) return { ok: false, reason: 'No such item.' };
        ctx = ctx || {};

        if (ctx.myTurn === false) return { ok: false, reason: "It is not your turn." };
        if (ctx.inCheck) return { ok: false, reason: 'You are in check.' };
        if (ctx.boughtThisTurn) return { ok: false, reason: 'You already used an item this turn.' };
        if (typeof ctx.coins === 'number' && ctx.coins < item.price) {
            return { ok: false, reason: 'Not enough coins.' };
        }
        if (item.notWhileEnemyInCheck && ctx.enemyInCheck) {
            return { ok: false, reason: 'Not while your opponent is in check.' };
        }
        if (item.id === 'no_castling' && ctx.enemyCanStillCastle === false) {
            return { ok: false, reason: 'Your opponent can no longer castle anyway.' };
        }
        if (item.id === 'dispel' && ctx.enemyEffectCount === 0) {
            return { ok: false, reason: 'Your opponent has no active effects.' };
        }
        if (item.id === 'resurrect' && normalizeCaptured(ctx.captured).length === 0) {
            return { ok: false, reason: 'You have not lost a piece yet.' };
        }
        if (ctx.activeIds && ctx.activeIds.indexOf(item.id) !== -1 && !item.permanent) {
            return { ok: false, reason: 'That effect is already running.' };
        }
        return { ok: true };
    }

    const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

    /** Kurzbeschreibung eines laufenden Effekts für die Effektleiste. */
    function describeEffect(effect) {
        if (effect && effect.hidden) return '❓ Unknown effect';
        const item = getItem(effect && effect.id);
        if (!item) return '❓ Unknown effect';
        const sq = (t) => {
            if (!t || !MoveGen.validCoords(t.r, t.c)) return '';
            return FILES[t.c] + (8 - t.r);
        };
        let where = '';
        if (Array.isArray(effect.squares) && effect.squares.length) {
            where = ' → ' + effect.squares.map(sq).filter(Boolean).join(', ');
        } else if (effect.target) {
            where = ' → ' + sq(effect.target);
        }
        let left = '';
        if (typeof effect.pliesLeft === 'number' && effect.pliesLeft > 0) {
            left = ' · ' + effect.pliesLeft + (effect.pliesLeft === 1 ? ' turn left' : ' turns left');
        } else if (typeof effect.chargesLeft === 'number' && effect.chargesLeft > 0) {
            left = ' · ' + effect.chargesLeft + '× left';
        }
        return item.icon + ' ' + item.name + where + left;
    }

    return {
        ITEMS, ITEM_LIST, SHOP_ORDER, TARGET_KINDS, FILES,
        CATEGORY_LABEL, CATEGORY_ORDER,
        getItem, upgradeOptions, UPGRADE_PATH,
        STREAK_TIERS, streakMultiplier, coinsForHit,
        isOwnHalf, backRank, normalizeCaptured,
        isValidTarget, validTargetSquares, canBuy, describeEffect
    };
});
