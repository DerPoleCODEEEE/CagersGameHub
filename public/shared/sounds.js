/**
 * Zentraler Sound-Manager für CagersGameHub.
 *
 * Alle Sounds unter /shared/sounds/ wurden prozedural erzeugt und sind
 * gemeinfrei (CC0) — keine Attribution nötig, keine externen CDNs, kein
 * Lizenzrisiko.
 *
 * Nutzung:
 *   Sfx.play('move');
 *   Sfx.mountToggle(document.getElementById('sound-toggle'));
 */
(function (global) {
    'use strict';

    const BASE = '/shared/sounds/';
    const NAMES = [
        'move', 'capture', 'castle', 'check', 'promote',
        'game-start', 'game-end', 'low-time', 'notify', 'illegal', 'cooldown-ready'
    ];

    const STORAGE_KEY_MUTED = 'cager_sfx_muted';
    const STORAGE_KEY_VOL = 'cager_sfx_volume';

    // Ein kleiner Pool pro Sound, damit sich schnell aufeinanderfolgende
    // Züge nicht gegenseitig abschneiden.
    const POOL_SIZE = 3;
    const pools = Object.create(null);
    const cursors = Object.create(null);

    let muted = false;
    let volume = 0.55;
    let unlocked = false;

    try {
        muted = localStorage.getItem(STORAGE_KEY_MUTED) === '1';
        const v = parseFloat(localStorage.getItem(STORAGE_KEY_VOL));
        if (!isNaN(v) && v >= 0 && v <= 1) volume = v;
    } catch (e) { /* localStorage kann blockiert sein */ }

    function build() {
        NAMES.forEach(name => {
            pools[name] = [];
            cursors[name] = 0;
            for (let i = 0; i < POOL_SIZE; i++) {
                const a = new Audio(BASE + name + '.mp3');
                a.preload = 'auto';
                a.volume = volume;
                pools[name].push(a);
            }
        });
    }

    if (typeof Audio !== 'undefined') build();

    /**
     * Browser blockieren Audio bis zur ersten Nutzerinteraktion. Beim ersten
     * Klick/Tastendruck spielen wir einmal lautlos an, danach ist alles frei.
     */
    function unlock() {
        if (unlocked || typeof Audio === 'undefined') return;
        unlocked = true;
        NAMES.forEach(name => {
            const a = pools[name] && pools[name][0];
            if (!a) return;
            const prev = a.volume;
            a.volume = 0;
            const p = a.play();
            if (p && typeof p.then === 'function') {
                p.then(() => { a.pause(); a.currentTime = 0; a.volume = prev; })
                 .catch(() => { a.volume = prev; });
            } else {
                try { a.pause(); a.currentTime = 0; } catch (e) {}
                a.volume = prev;
            }
        });
    }

    if (typeof document !== 'undefined') {
        ['pointerdown', 'keydown', 'touchstart'].forEach(evt => {
            document.addEventListener(evt, unlock, { once: true, passive: true });
        });
    }

    function play(name, opts) {
        if (muted || typeof Audio === 'undefined') return;
        const pool = pools[name];
        if (!pool || !pool.length) return;
        const idx = cursors[name] % pool.length;
        cursors[name] = (cursors[name] + 1) % pool.length;
        const a = pool[idx];
        try {
            a.currentTime = 0;
            a.volume = Math.max(0, Math.min(1, (opts && opts.volume !== undefined ? opts.volume : 1) * volume));
            const p = a.play();
            if (p && typeof p.catch === 'function') p.catch(() => { /* Autoplay-Policy */ });
        } catch (e) { /* nie das Spiel wegen eines Sounds abbrechen */ }
    }

    /**
     * Wählt anhand des Zugtyps den passenden Sound.
     * @param {object} info { type, captured, promoted, check }
     */
    function playMove(info) {
        info = info || {};
        if (info.promoted) return play('promote');
        if (info.type === 'castle') return play('castle');
        if (info.check) return play('check');
        if (info.captured || info.type === 'capture' || info.type === 'en_passant') return play('capture');
        if (info.type === 'merge') return play('promote', { volume: 0.8 });
        return play('move');
    }

    function setMuted(v) {
        muted = !!v;
        try { localStorage.setItem(STORAGE_KEY_MUTED, muted ? '1' : '0'); } catch (e) {}
        return muted;
    }

    function isMuted() { return muted; }

    function setVolume(v) {
        volume = Math.max(0, Math.min(1, v));
        try { localStorage.setItem(STORAGE_KEY_VOL, String(volume)); } catch (e) {}
        NAMES.forEach(n => (pools[n] || []).forEach(a => { a.volume = volume; }));
    }

    /**
     * Hängt einen Mute-Umschalter an einen Button. Der Button-Text und
     * aria-pressed werden automatisch gepflegt.
     */
    function mountToggle(btn) {
        if (!btn) return;
        const sync = () => {
            btn.innerText = muted ? '🔇 Sound off' : '🔊 Sound on';
            btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
            btn.setAttribute('aria-label', muted ? 'Sound einschalten' : 'Sound ausschalten');
        };
        btn.addEventListener('click', () => { setMuted(!muted); sync(); if (!muted) play('move'); });
        sync();
    }

    /** Erzeugt einen Mute-Button und hängt ihn oben rechts an. */
    function mountFloatingToggle() {
        if (typeof document === 'undefined') return null;
        if (document.getElementById('sfx-toggle-btn')) return document.getElementById('sfx-toggle-btn');
        const btn = document.createElement('button');
        btn.id = 'sfx-toggle-btn';
        btn.type = 'button';
        btn.className = 'sfx-toggle-btn';
        document.body.appendChild(btn);
        mountToggle(btn);
        return btn;
    }

    global.Sfx = { play, playMove, setMuted, isMuted, setVolume, mountToggle, mountFloatingToggle, unlock, NAMES };
})(typeof self !== 'undefined' ? self : this);
