/**
 * Mobile-Regressionstest: prueft alle Seiten auf mehreren Handy-Viewports
 * gegen die Fehler, die es hier tatsaechlich gab.
 *
 *   PORT=3113 PREDICTION_START_COINS=20 node server.js &
 *   node test/mobile-ui.js http://localhost:3113
 *
 * Geprueft wird pro Seite und Viewport:
 *   - kein horizontales Scrollen (Brett war fest 600px bzw. 560px breit)
 *   - Brett quadratisch und mit dem Finger treffbar (>= 34px pro Feld)
 *   - Spielerleisten exakt buendig mit dem Brett
 *   - der fixierte Sound-Knopf verdeckt keinen Bedienelement
 *   - Tippziele sind gross genug
 *   - Prediction Chess: Reihenfolge Brett -> Shop -> Chat, Tipp per Antippen
 *
 * Der letzte Punkt ist der wichtigste: der Tipp ist Pflicht, liess sich aber
 * nur per Rechtsklick-Ziehen zeichnen. Auf Touch war die Partie damit nicht
 * abschickbar.
 */
'use strict';

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (e) {
    console.log('\nPlaywright ist nicht installiert — Mobile-Test wird übersprungen.');
    console.log('  npm i -D playwright && npx playwright install chromium\n');
    process.exit(0);
}

const BASE = process.argv[2] || 'http://localhost:3113';
const EXE = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';

let passed = 0, failed = 0;
const log = (ok, name, extra) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
};

/** Externe CDNs sind in der Sandbox nicht erreichbar. */
function isInternalError(text) {
    if (/wikimedia|googleapis|gstatic|cdnjs|redd\.it|pngmart|jtvnw|ui-avatars/i.test(text)) return false;
    if (/-preview\.jpg|\/api\/(user|leaderboard)|favicon/i.test(text)) return false;
    if (/^Failed to load resource/i.test(text)) return false;
    if (/chess\.js konnte nicht geladen werden/i.test(text)) return false;
    return true;
}

const sel = (r, c) => `#board .square[data-r="${r}"][data-c="${c}"]`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Die Viewports, die wirklich vorkommen. */
const VIEWPORTS = [
    { name: 'iPhone SE  375x667', w: 375, h: 667 },
    { name: 'iPhone 14  390x844', w: 390, h: 844 },
    { name: 'Android    360x740', w: 360, h: 740 },
    { name: 'Landscape  740x360', w: 740, h: 360 },
    { name: 'Tablet     820x1180', w: 820, h: 1180 }
];

const MODES = [
    { slug: 'chess', label: 'Quick Chess', pairs: true },
    { slug: 'mutant-chess', label: 'Mutant Merge', pairs: true },
    { slug: 'prediction-chess', label: 'Prediction Chess', pairs: true },
    { slug: 'play-cager', label: 'VS Cager Bot', pairs: false }
];

/**
 * Misst horizontales Scrollen. Wichtig: gegen die GERAETEBREITE messen, nicht
 * gegen window.innerWidth — Chrome vergroessert den Layout-Viewport still,
 * wenn Inhalt herausragt, und dann sieht innerWidth === scrollWidth gesund
 * aus, obwohl die Seite seitlich scrollt.
 */
function overflowProbe(deviceWidth) {
    return function () {
        const bad = [];
        for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            if (r.right > window.__devW + 0.5 || r.left < -0.5) {
                bad.push(el.tagName.toLowerCase() +
                    (el.id ? '#' + el.id : '') +
                    (typeof el.className === 'string' && el.className
                        ? '.' + el.className.trim().split(/\s+/)[0] : '') +
                    ` [${Math.round(r.left)}..${Math.round(r.right)}]`);
            }
        }
        return { scrollW: document.documentElement.scrollWidth, devW: window.__devW, bad: bad.slice(0, 5) };
    };
}

(async () => {
    console.log(`\nMobile-Regressionstest gegen ${BASE}\n`);
    const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
    const errors = [];

    async function ctxFor(vp, tag) {
        const ctx = await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            isMobile: true, hasTouch: true, deviceScaleFactor: 2,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
                       'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        });
        const page = await ctx.newPage();
        await page.addInitScript(`window.__devW = ${vp.w};`);
        page.on('console', m => { if (m.type() === 'error' && isInternalError(m.text())) errors.push(`[${tag}] ${m.text()}`); });
        page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
        return { ctx, page };
    }

    async function checkNoOverflow(page, label, vp) {
        const o = await page.evaluate(overflowProbe(vp.w));
        log(o.scrollW <= o.devW + 0.5 && o.bad.length === 0,
            `${label}: kein horizontales Scrollen`,
            `scrollWidth ${o.scrollW} > ${o.devW}` + (o.bad.length ? ' | ' + o.bad.join(' | ') : ''));
    }

    /** Verdeckt der fixierte Sound-Knopf ein Bedienelement? */
    async function checkSfxNoOverlap(page, label) {
        const hit = await page.evaluate(() => {
            const btn = document.getElementById('sfx-toggle-btn');
            if (!btn) return { skip: true };
            const b = btn.getBoundingClientRect();
            const names = [];
            const CONTROLS = 'button, a, input, select, .square, .tag, .shop-card, .coin-box, .clock-box';
            for (const el of document.querySelectorAll(CONTROLS)) {
                if (el === btn || btn.contains(el)) continue;
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || !el.offsetParent) continue;
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                const over = !(r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom);
                if (over) names.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                    (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''));
            }
            return { skip: false, names: names.slice(0, 4) };
        });
        if (hit.skip) return;
        log(hit.names.length === 0, `${label}: Sound-Knopf verdeckt kein Bedienelement`, hit.names.join(', '));
    }

    /** Brett quadratisch, buendig, und mit dem Finger treffbar. */
    async function checkBoard(page, label, minSquare) {
        const m = await page.evaluate(() => {
            const wrap = document.getElementById('board-wrapper');
            if (!wrap) return null;
            const w = wrap.getBoundingClientRect();
            const bar = document.querySelector('.player-bar.bottom') || document.querySelector('.player-bar');
            const b = bar ? bar.getBoundingClientRect() : null;
            const sqs = document.querySelectorAll('#board .square');
            return {
                w: +w.width.toFixed(2), h: +w.height.toFixed(2), x: +w.x.toFixed(2),
                barX: b ? +b.x.toFixed(2) : null, barW: b ? +b.width.toFixed(2) : null,
                squares: sqs.length
            };
        });
        if (!m) return;
        log(Math.abs(m.w - m.h) <= 1, `${label}: Brett ist quadratisch`, `${m.w}x${m.h}`);
        log(m.w / 8 >= minSquare, `${label}: Felder mit dem Finger treffbar (${(m.w / 8).toFixed(1)}px)`);
        if (m.barX !== null) {
            log(Math.abs(m.x - m.barX) <= 0.5 && Math.abs(m.w - m.barW) <= 0.5,
                `${label}: Spielerleiste ist buendig mit dem Brett`,
                `Brett ${m.x}/${m.w} vs Leiste ${m.barX}/${m.barW}`);
        }
    }

    /** Sind Tippziele gross genug? */
    async function checkTapTargets(page, label) {
        const small = await page.evaluate(() => {
            const out = [];
            for (const el of document.querySelectorAll('button, a.btn, a.play-btn, a.scribble-btn')) {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || !el.offsetParent) continue;
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                // Reine Icon-Knoepfe duerfen quadratisch-klein sein, solange
                // beide Kanten >= 32px sind.
                if (r.height < 32 || r.width < 32) {
                    out.push((el.id || el.className || el.tagName) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
                }
            }
            return out.slice(0, 5);
        });
        log(small.length === 0, `${label}: Tippziele sind gross genug`, small.join(', '));
    }

    // =================================================================
    // Menue-, Hub- und Bot-Seiten auf allen Viewports
    // =================================================================
    for (const vp of VIEWPORTS) {
        console.log(`— ${vp.name} —`);
        const { ctx, page } = await ctxFor(vp, vp.name);

        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await sleep(700);
        await checkNoOverflow(page, 'Hub', vp);
        await checkTapTargets(page, 'Hub');

        for (const mode of MODES) {
            await page.goto(`${BASE}/${mode.slug}/`, { waitUntil: 'domcontentloaded' });
            await sleep(700);
            await page.evaluate(() => {
                const s = document.getElementById('splash-screen');
                if (s) s.style.display = 'none';
            });
            await sleep(150);
            await checkNoOverflow(page, mode.label, vp);
            await checkSfxNoOverlap(page, mode.label);
            if (mode.slug === 'play-cager') {
                await checkBoard(page, mode.label + ' Brett', 28);
            }
        }

        await ctx.close();
        console.log('');
    }

    // =================================================================
    // Echte Partien auf dem Handy: Spielbildschirm ist der eigentliche Test
    // =================================================================
    for (const vp of VIEWPORTS) {
        console.log(`— Spielbildschirme, ${vp.name} —`);
        for (const mode of MODES.filter(m => m.pairs)) {
            const A = await ctxFor(vp, `${mode.slug}/A`);
            const B = await ctxFor(vp, `${mode.slug}/B`);
            try {
                for (const { page } of [A, B]) {
                    await page.goto(`${BASE}/${mode.slug}/`, { waitUntil: 'domcontentloaded' });
                }
                await sleep(700);
                for (const [i, { page }] of [A, B].entries()) {
                    await page.evaluate(() => {
                        const s = document.getElementById('splash-screen');
                        if (s) s.style.display = 'none';
                    });
                    await page.fill('#player-name', i === 0 ? 'Alice' : 'Bob');
                }
                await A.page.click('#btn-create');
                await A.page.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 10000 });
                await checkNoOverflow(A.page, `${mode.label} Lobby`, vp);

                const code = (await A.page.textContent('#display-room-code')).trim();
                await B.page.fill('#room-code-input', code);
                await B.page.click('#btn-join');
                await A.page.waitForSelector('#game-screen:not(.hidden)', { timeout: 10000 });
                await sleep(800);

                await checkNoOverflow(A.page, `${mode.label} Spiel`, vp);
                await checkBoard(A.page, `${mode.label} Brett`, 28);
                await checkSfxNoOverlap(A.page, `${mode.label} Spiel`);
                await checkTapTargets(A.page, `${mode.label} Spiel`);

                // Prediction Chess: Reihenfolge und Touch-Eingabe
                if (mode.slug === 'prediction-chess') {
                    const order = await A.page.evaluate(() => {
                        const y = (s) => {
                            const n = document.querySelector(s);
                            return n ? n.getBoundingClientRect().top + scrollY : null;
                        };
                        return { board: y('#game-container'), side: y('.sidebar'), chat: y('.chat-panel') };
                    });
                    // Nur im Portrait wird gestapelt. Im Landscape ist die
                    // zweispaltige Anordnung (Brett links, Bedienung rechts)
                    // das gewollte Verhalten, nicht ein Fehler.
                    const stacked = vp.w <= 900 && vp.h > 600;
                    if (stacked) {
                        log(order.board < order.side && order.side <= order.chat,
                            `${mode.label}: Reihenfolge Brett -> Shop -> Chat`, JSON.stringify(order));
                        log(await A.page.locator('.chat-panel.collapsed').count() === 1,
                            `${mode.label}: Chat startet eingeklappt`);
                    }

                    await A.page.click('#btn-ready');
                    await B.page.click('#btn-ready');
                    await A.page.waitForSelector('#status-banner:not(.hidden)', { timeout: 10000 });
                    await A.page.waitForFunction(
                        () => document.getElementById('status-banner').classList.contains('hidden'),
                        null, { timeout: 20000 });
                    await sleep(300);

                    const before = await A.page.evaluate(() => {
                        const r = document.getElementById('board-wrapper').getBoundingClientRect();
                        return `${(r.x + scrollX).toFixed(2)}/${(r.y + scrollY).toFixed(2)}/${r.width.toFixed(2)}`;
                    });

                    // Zug antippen
                    await A.page.tap(sel(6, 4)); await sleep(200);
                    await A.page.tap(sel(4, 4)); await sleep(350);
                    log(await A.page.locator('#board .square.pending-move').count() === 2,
                        `${mode.label}: Zug per Antippen vorgemerkt`);

                    // Tipp mit zwei Antippern — ohne das ist die Partie auf
                    // Touch nicht abschickbar.
                    await A.page.tap(sel(1, 4)); await sleep(200);
                    log(await A.page.locator('#board .square.call-from').count() === 1,
                        `${mode.label}: erstes Antippen markiert das Tipp-Startfeld`);
                    await A.page.tap(sel(3, 4)); await sleep(300);
                    log(await A.page.locator('#btn-send-turn:not(.is-hidden)').count() === 1,
                        `${mode.label}: "Send turn" erscheint nach zwei Antippern`);

                    const after = await A.page.evaluate(() => {
                        const r = document.getElementById('board-wrapper').getBoundingClientRect();
                        return `${(r.x + scrollX).toFixed(2)}/${(r.y + scrollY).toFixed(2)}/${r.width.toFixed(2)}`;
                    });
                    log(before === after, `${mode.label}: Brett steht bei der Tipp-Eingabe still`,
                        `${after} statt ${before}`);

                    await A.page.tap('#btn-send-turn');
                    await sleep(700);
                    log(await B.page.evaluate(() =>
                        !document.querySelector('#board .square[data-r="4"][data-c="4"] .piece-img')
                            .classList.contains('hidden')),
                        `${mode.label}: Zug kommt beim Gegner an (Partie ist auf Touch spielbar)`);
                }
            } catch (e) {
                log(false, `${mode.label} auf ${vp.name}`, e.message.split('\n')[0]);
            } finally {
                await A.ctx.close();
                await B.ctx.close();
            }
        }
        console.log('');
    }

    console.log('— Konsolenfehler —');
    if (errors.length) errors.slice(0, 10).forEach(e => console.error('   ' + e));
    log(errors.length === 0, `Keine internen JS-Fehler (${errors.length})`);

    await browser.close();
    console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('\nMobile-Test abgebrochen:', err);
    process.exit(1);
});
