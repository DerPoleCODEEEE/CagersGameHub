/**
 * Zeichenpfeile zum Rechnen — Rechtsklick ziehen, wie man es von chess.com kennt.
 *
 *   Rechtsklick ziehen     Pfeil setzen
 *   denselben Pfeil nochmal  entfernt ihn wieder
 *   Linksklick aufs Brett   löscht alle Pfeile
 *
 * Die Pfeile sind rein lokal: sie gehen nie an den Server, der Gegner sieht
 * nichts davon.
 *
 * Erwartet ein Brett mit `.square[data-r][data-c]`. Ein gedrehtes Brett
 * (`#board.flipped` mit `rotate(180deg)`) braucht keine Sonderbehandlung — die
 * Zeichenebene liegt im Brett und dreht sich einfach mit.
 *
 * WICHTIG: keine Node-APIs, keine Abhängigkeiten.
 */
(function (root) {
    'use strict';

    const NS = 'http://www.w3.org/2000/svg';
    const STYLE_ID = 'board-arrows-style';
    const COLOR = '#f0a30a';   // Orange — hebt sich von allen Brettfarben ab

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.textContent =
            '.annot-layer{position:absolute;inset:0;width:100%;height:100%;' +
            'pointer-events:none;z-index:40;overflow:visible}' +
            '.annot-arrow{fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:.85}' +
            '.annot-arrow.outline{stroke:#000;stroke-width:15;opacity:.5}' +
            '.annot-draft{opacity:.5}';
        document.head.appendChild(tag);
    }

    const center = (r, c) => ({ x: c * 100 + 50, y: r * 100 + 50 });

    /** Leicht gebogener, handgezeichnet wirkender Pfeil. */
    function arrowPath(a) {
        const p1 = center(a.fromR, a.fromC);
        const p2 = center(a.toR, a.toC);
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = Math.min(30, len * 0.12);
        const mx = (p1.x + p2.x) / 2 + (-dy / len) * bow;
        const my = (p1.y + p2.y) / 2 + (dx / len) * bow;

        const back = 26;
        const ex = p2.x - (dx / len) * back;
        const ey = p2.y - (dy / len) * back;

        const ang = Math.atan2(ey - my, ex - mx);
        const head = 26;
        const h1x = ex - head * Math.cos(ang - 0.42), h1y = ey - head * Math.sin(ang - 0.42);
        const h2x = ex - head * Math.cos(ang + 0.42), h2y = ey - head * Math.sin(ang + 0.42);

        return 'M ' + p1.x + ' ' + p1.y + ' Q ' + mx + ' ' + my + ' ' + ex + ' ' + ey +
               ' M ' + h1x + ' ' + h1y + ' L ' + ex + ' ' + ey + ' L ' + h2x + ' ' + h2y;
    }

    /**
     * @param {object} opts
     * @param {Element|string} opts.board  Brett mit .square[data-r][data-c]
     * @param {function} [opts.enabled]    liefert false => Rechtsklick bleibt frei
     */
    function attach(opts) {
        opts = opts || {};
        const board = typeof opts.board === 'string' ? document.querySelector(opts.board) : opts.board;
        if (!board) return null;
        const enabled = typeof opts.enabled === 'function' ? opts.enabled : function () { return true; };

        injectStyle();
        if (getComputedStyle(board).position === 'static') board.style.position = 'relative';

        const layer = document.createElementNS(NS, 'svg');
        layer.setAttribute('class', 'annot-layer');
        layer.setAttribute('viewBox', '0 0 800 800');
        layer.setAttribute('aria-hidden', 'true');
        board.appendChild(layer);

        // Die Modi bauen ihr Brett neu auf (leeren + Felder anhaengen) und
        // wuerden die Zeichenebene dabei mitentfernen. Deshalb haengt sie sich
        // selbst wieder ein, sobald sich die Kinder des Bretts aendern.
        if (typeof MutationObserver === 'function') {
            new MutationObserver(function () {
                if (layer.parentNode !== board) board.appendChild(layer);
            }).observe(board, { childList: true });
        }

        const arrows = [];
        let drag = null;

        function squareOf(ev) {
            const el = ev.target && ev.target.closest ? ev.target.closest('.square') : null;
            if (!el || !board.contains(el)) return null;
            const r = parseInt(el.dataset.r, 10), c = parseInt(el.dataset.c, 10);
            if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
            return { r: r, c: c };
        }

        function path(d, cls, width) {
            const p = document.createElementNS(NS, 'path');
            p.setAttribute('d', d);
            p.setAttribute('class', cls);
            if (width) { p.setAttribute('stroke', COLOR); p.setAttribute('stroke-width', String(width)); }
            return p;
        }

        function draw() {
            if (layer.parentNode !== board) board.appendChild(layer);
            while (layer.firstChild) layer.removeChild(layer.firstChild);
            arrows.forEach(function (a) {
                const d = arrowPath(a);
                layer.appendChild(path(d, 'annot-arrow outline'));
                layer.appendChild(path(d, 'annot-arrow', 11));
            });
            if (drag && (drag.fromR !== drag.toR || drag.fromC !== drag.toC)) {
                const d = arrowPath(drag);
                layer.appendChild(path(d, 'annot-arrow outline annot-draft'));
                layer.appendChild(path(d, 'annot-arrow annot-draft', 11));
            }
        }

        function toggleArrow(a) {
            const i = arrows.findIndex(function (x) {
                return x.fromR === a.fromR && x.fromC === a.fromC && x.toR === a.toR && x.toC === a.toC;
            });
            if (i === -1) arrows.push(a); else arrows.splice(i, 1);
        }

        function clear() {
            if (!arrows.length && !drag) return false;
            arrows.length = 0; drag = null;
            draw();
            return true;
        }

        board.addEventListener('contextmenu', function (ev) { if (enabled()) ev.preventDefault(); });

        board.addEventListener('mousedown', function (ev) {
            if (ev.button === 0) { clear(); return; }
            if (ev.button !== 2 || !enabled()) return;
            const sq = squareOf(ev);
            if (!sq) return;
            ev.preventDefault();
            drag = { fromR: sq.r, fromC: sq.c, toR: sq.r, toC: sq.c };
        });

        board.addEventListener('mousemove', function (ev) {
            if (!drag) return;
            const sq = squareOf(ev);
            if (!sq || (sq.r === drag.toR && sq.c === drag.toC)) return;
            drag.toR = sq.r; drag.toC = sq.c;
            draw();
        });

        board.addEventListener('mouseup', function (ev) {
            if (ev.button !== 2 || !drag) return;
            const sq = squareOf(ev) || { r: drag.toR, c: drag.toC };
            // Auf demselben Feld losgelassen heisst: doch keinen Pfeil.
            if (sq.r !== drag.fromR || sq.c !== drag.fromC) {
                toggleArrow({ fromR: drag.fromR, fromC: drag.fromC, toR: sq.r, toC: sq.c });
            }
            drag = null;
            draw();
        });

        // Ausserhalb des Bretts losgelassen: Entwurf verwerfen.
        document.addEventListener('mouseup', function (ev) {
            if (ev.button === 2 && drag) { drag = null; draw(); }
        });

        return { clear: clear, count: function () { return arrows.length; }, redraw: draw };
    }

    root.BoardArrows = { attach: attach, COLOR: COLOR };
})(typeof self !== 'undefined' ? self : this);
