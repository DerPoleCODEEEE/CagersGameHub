/**
 * Kleine, sichere DOM-Helfer. Ziel: kein `innerHTML` mehr mit Fremddaten.
 */
(function (global) {
    'use strict';

    /** Escaped Text für den HTML-Textkontext. */
    function escapeHtml(text) {
        return String(text === undefined || text === null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Erlaubt nur http(s)- und data:image-URLs. Alles andere (javascript:,
     * vbscript:, data:text/html …) wird durch den Fallback ersetzt.
     */
    function safeImageUrl(url, fallback) {
        fallback = fallback || '';
        if (typeof url !== 'string' || !url) return fallback;
        const trimmed = url.trim();
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(trimmed)) return trimmed;
        if (/^\/[^/]/.test(trimmed)) return trimmed; // eigener, relativer Pfad
        return fallback;
    }

    /** document.createElement mit Attributen und Textinhalt — nie innerHTML. */
    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(k => {
                const v = attrs[k];
                if (v === undefined || v === null || v === false) return;
                if (k === 'class') node.className = v;
                else if (k === 'dataset') Object.keys(v).forEach(d => { node.dataset[d] = v[d]; });
                else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
                else node.setAttribute(k, v === true ? '' : v);
            });
        }
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    /** Entfernt alle Kindknoten (schneller und sicherer als innerHTML = ''). */
    function clear(node) {
        if (!node) return node;
        while (node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    /**
     * Relative Luminanz eines Hex-Farbwerts (WCAG). Wird benutzt, um für
     * eingefärbte Achievement-Karten automatisch lesbaren Text zu wählen.
     */
    function luminance(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
        if (!m) return 1;
        const ch = [m[1], m[2], m[3]].map(h => {
            const v = parseInt(h, 16) / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }

    /** Liefert '#111' oder '#fff' — je nachdem, was auf `bgHex` besser lesbar ist. */
    function readableTextColor(bgHex) {
        const L = luminance(bgHex);
        const contrastWithDark = (L + 0.05) / (luminance('#111111') + 0.05);
        const contrastWithLight = (luminance('#ffffff') + 0.05) / (L + 0.05);
        return contrastWithDark >= contrastWithLight ? '#111111' : '#ffffff';
    }

    /** Debounce für Eingabefelder. */
    function debounce(fn, wait) {
        let t = null;
        return function () {
            const args = arguments, ctx = this;
            clearTimeout(t);
            t = setTimeout(() => fn.apply(ctx, args), wait);
        };
    }

    /**
     * Macht ein Element per Tastatur bedienbar (Enter/Leertaste lösen `onActivate` aus).
     */
    function makeKeyboardActivatable(node, onActivate, label) {
        node.setAttribute('tabindex', '0');
        node.setAttribute('role', 'button');
        if (label) node.setAttribute('aria-label', label);
        node.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                onActivate(e);
            }
        });
    }

    /**
     * Basis-Zugänglichkeit für Modals: Escape schließt, Fokus bleibt gefangen,
     * Fokus kehrt beim Schließen zum auslösenden Element zurück.
     */
    function makeAccessibleModal(modal, onClose) {
        if (!modal) return { open() {}, close() {} };
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        let lastFocused = null;

        const focusables = () => Array.from(modal.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(n => n.offsetParent !== null);

        const onKeydown = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(); return; }
            if (e.key !== 'Tab') return;
            const f = focusables();
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };

        function open() {
            lastFocused = document.activeElement;
            modal.style.display = 'flex';
            document.addEventListener('keydown', onKeydown);
            const f = focusables();
            if (f.length) f[0].focus();
        }

        function close() {
            modal.style.display = 'none';
            document.removeEventListener('keydown', onKeydown);
            if (lastFocused && lastFocused.focus) lastFocused.focus();
            if (typeof onClose === 'function') onClose();
        }

        return { open, close };
    }

    global.DomUtils = {
        escapeHtml, safeImageUrl, el, clear,
        luminance, readableTextColor, debounce,
        makeKeyboardActivatable, makeAccessibleModal
    };
})(typeof self !== 'undefined' ? self : this);
