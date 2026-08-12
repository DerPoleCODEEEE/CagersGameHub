/**
 * Gemeinsame Figuren-Grafiken und Cooldown-Defaults.
 * Vorher standen diese Tabellen dreimal identisch im Repo.
 */
(function (global) {
    'use strict';

    const WIKI = 'https://upload.wikimedia.org/wikipedia/commons/';

    const PIECE_IMAGES = {
        P: WIKI + '4/45/Chess_plt45.svg',
        N: WIKI + '7/70/Chess_nlt45.svg',
        B: WIKI + 'b/b1/Chess_blt45.svg',
        R: WIKI + '7/72/Chess_rlt45.svg',
        Q: WIKI + '1/15/Chess_qlt45.svg',
        K: WIKI + '4/42/Chess_klt45.svg',
        p: WIKI + 'c/c7/Chess_pdt45.svg',
        n: WIKI + 'e/ef/Chess_ndt45.svg',
        b: WIKI + '9/98/Chess_bdt45.svg',
        r: WIKI + 'f/ff/Chess_rdt45.svg',
        q: WIKI + '4/47/Chess_qdt45.svg',
        k: WIKI + 'f/f0/Chess_kdt45.svg'
    };

    /** Einzige Quelle für die Standard-Cooldowns (vorher 5x dupliziert). */
    const DEFAULT_COOLDOWNS = { k: 1000, p: 3500, n: 6500, b: 6500, r: 10000, q: 14000 };

    /** Grenzen für vom Client gewählte Cooldowns (Server validiert dagegen). */
    const COOLDOWN_BOUNDS = { min: 200, max: 30000 };

    /** Baut die PIECES-Struktur, die die Spiel-Clients erwarten. */
    function buildPieces(cooldowns) {
        const cd = Object.assign({}, DEFAULT_COOLDOWNS, cooldowns || {});
        const out = {};
        Object.keys(PIECE_IMAGES).forEach(ch => {
            const key = ch.toLowerCase();
            out[ch] = {
                img: PIECE_IMAGES[ch],
                color: ch === ch.toUpperCase() ? 'w' : 'b',
                cd: cd[key] !== undefined ? cd[key] : DEFAULT_COOLDOWNS[key]
            };
        });
        return out;
    }

    const api = { PIECE_IMAGES, DEFAULT_COOLDOWNS, COOLDOWN_BOUNDS, buildPieces };

    if (typeof module === 'object' && module.exports) module.exports = api;
    else global.PieceAssets = api;
})(typeof self !== 'undefined' ? self : this);
