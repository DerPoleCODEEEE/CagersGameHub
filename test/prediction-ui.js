/**
 * UI-Smoketest für Prediction Chess: zwei echte Browser spielen gegeneinander,
 * zeichnen Tipps und kaufen Items.
 *
 *   PORT=3112 PREDICTION_START_COINS=20 node server.js &
 *   node test/prediction-ui.js http://localhost:3112
 */
'use strict';

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (e) {
    console.log('\nPlaywright ist nicht installiert — UI-Test wird übersprungen.');
    console.log('  npm i -D playwright && npx playwright install chromium\n');
    process.exit(0);
}

const BASE = process.argv[2] || 'http://localhost:3112';
let passed = 0, failed = 0;
const log = (ok, name, extra) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
};

/** Externe CDNs sind in dieser Sandbox nicht erreichbar. */
function isInternalError(text) {
    if (/wikimedia|googleapis|gstatic|cdnjs|redd\.it|pngmart|jtvnw|ui-avatars/i.test(text)) return false;
    if (/\/api\/(user|leaderboard)|favicon/i.test(text)) return false;
    if (/^Failed to load resource/i.test(text)) return false;
    return true;
}

const sel = (r, c) => `#board .square[data-r="${r}"][data-c="${c}"]`;

(async () => {
    console.log(`\nPrediction-Chess-UI gegen ${BASE}\n`);
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const errors = [];

    async function newPage(tag) {
        const page = await (await browser.newContext()).newPage();
        page.on('console', m => { if (m.type() === 'error' && isInternalError(m.text())) errors.push(`[${tag}] ${m.text()}`); });
        page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
        return page;
    }

    /** Rechtsklick-Ziehen von Feld zu Feld — so entsteht der Tipp-Pfeil. */
    async function dragArrow(page, from, to) {
        const a = await page.locator(sel(from[0], from[1])).boundingBox();
        const b = await page.locator(sel(to[0], to[1])).boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(150);
    }

    async function move(page, from, to) {
        await page.click(sel(from[0], from[1]));
        await page.waitForTimeout(120);
        await page.click(sel(to[0], to[1]));
        await page.waitForTimeout(450);
    }

    // =================================================================
    console.log('— Aufbau —');
    const w = await newPage('white');
    const b = await newPage('black');
    await w.goto(BASE + '/prediction-chess/', { waitUntil: 'domcontentloaded' });
    await b.goto(BASE + '/prediction-chess/', { waitUntil: 'domcontentloaded' });
    await w.waitForTimeout(800);

    log(await w.evaluate(() => typeof window.MoveGen === 'object'), 'move-gen.js geladen');
    log(await w.evaluate(() => typeof window.Items === 'object'), 'items.js geladen');
    log(await w.evaluate(() => window.Items.ITEM_LIST.length === 16), '16 Items in der Registry');
    log(await w.locator('script:not([src])').count() === 0, 'Kein Inline-Script (CSP-tauglich)');
    log(await w.locator('.shop-card').count() === 16, 'Shop zeigt alle 16 Karten');
    log(await w.locator('.item-row').count() === 16, 'Regelbuch listet alle Items');

    await w.fill('#player-name', 'Alice');
    await w.click('#btn-create');
    await w.waitForSelector('#lobby-screen:not(.hidden)', { timeout: 5000 });
    const code = (await w.textContent('#display-room-code')).trim();
    log(/^[A-Z0-9]{6}$/.test(code), `Raumcode erzeugt (${code})`);

    await b.fill('#player-name', 'Bob');
    await b.fill('#room-code-input', code);
    await b.click('#btn-join');
    await b.waitForSelector('#game-screen:not(.hidden)', { timeout: 5000 });
    await w.waitForSelector('#game-screen:not(.hidden)', { timeout: 5000 });
    log(await w.locator('#board .square').count() === 64, 'Brett hat 64 Felder');
    log(await w.evaluate(() => {
        const s = document.querySelector('#board .square');
        return s.getAttribute('tabindex') === '0' && s.getAttribute('role') === 'gridcell';
    }), 'Felder sind fokussierbar');

    // =================================================================
    console.log('\n— Shop-Sperre —');
    log(await w.locator('#shop-lock:not(.hidden)').count() === 1, 'Shop ist vor Spielbeginn sichtbar gesperrt');
    log(/waiting/i.test(await w.textContent('#shop-lock-reason')), 'Sperrgrund steht im Klartext');
    log(await w.evaluate(() => getComputedStyle(document.querySelector('#shop-section .shop-grid')).filter.includes('grayscale')),
        'Gesperrter Shop ist ausgegraut');

    await w.click('#btn-ready');
    await b.click('#btn-ready');
    await w.waitForSelector('#status-banner:not(.hidden)', { timeout: 5000 });
    await w.waitForFunction(() => document.getElementById('status-banner').classList.contains('hidden'),
        null, { timeout: 15000 });
    log(true, 'Countdown beendet, Partie läuft');

    log(await b.locator('#shop-lock:not(.hidden)').count() === 1, 'Schwarz kann nicht kaufen, solange Weiß am Zug ist');
    log(/not your turn/i.test(await b.textContent('#shop-lock-reason')), 'Sperrgrund bei Schwarz stimmt');
    log(await w.locator('#shop-lock.hidden').count() === 1, 'Weiß darf am Zug kaufen');

    // =================================================================
    console.log('\n— Ziehen ohne Tipp —');
    // Der Tipp ist freiwillig. Dieser Pfad war lange ungetestet, obwohl es
    // der erste ist, den jeder Spieler nimmt.
    await w.click(sel(7, 1));
    await w.waitForTimeout(200);
    log(await w.locator('#board .square.selected').count() === 1, 'Figur lässt sich ohne Tipp auswählen');
    log(await w.locator('#board .square.valid-move').count() === 2, 'Zugvorschläge erscheinen ohne Tipp');
    await w.keyboard.press('Escape');

    // =================================================================
    console.log('\n— Tipp zeichnen —');
    // Das Brett darf sich beim Zeichnen nicht bewegen: sonst klickt man
    // danach auf die Stelle, wo die Figur eben noch war.
    const boxBefore = await w.locator('#board-wrapper').boundingBox();
    await dragArrow(w, [1, 4], [3, 4]);   // Tipp: e7–e5
    const boxAfter = await w.locator('#board-wrapper').boundingBox();
    log(boxBefore.x === boxAfter.x && boxBefore.y === boxAfter.y &&
        boxBefore.width === boxAfter.width,
        'Brett bleibt beim Zeichnen exakt stehen',
        `dx=${boxAfter.x - boxBefore.x} dy=${boxAfter.y - boxBefore.y}`);
    log(await w.locator('#arrow-layer path').count() >= 2, 'Pfeil wird gezeichnet');
    log(/calling e7→e5/i.test(await w.textContent('#predict-text')), 'Tipp steht in der Leiste');
    log(await b.locator('#arrow-layer path').count() === 0, 'Der Gegner sieht den offenen Tipp nicht');

    // Nach dem Zeichnen muss die Auswahl weiterhin funktionieren.
    await w.click(sel(6, 4));
    await w.waitForTimeout(200);
    log(await w.locator('#board .square.selected').count() === 1, 'Auswählen funktioniert auch nach dem Tipp');
    await w.keyboard.press('Escape');

    await move(w, [6, 4], [4, 4]);        // e2–e4
    log(await w.evaluate(() => !document.querySelector('#board .square[data-r="4"][data-c="4"] .piece-img').classList.contains('hidden')),
        'Zug kommt auf dem eigenen Brett an');
    log(await b.evaluate(() => !document.querySelector('#board .square[data-r="4"][data-c="4"] .piece-img').classList.contains('hidden')),
        'Zug kommt beim Gegner an');

    // Schwarz erfüllt den Tipp
    await move(b, [1, 4], [3, 4]);        // e7–e5
    await w.waitForTimeout(400);
    log(await w.textContent('#bottom-coins .coin-num') === '21', 'Treffer bringt eine Münze');
    log(await w.locator('.streak-dot.on').count() === 1, 'Streak-Punkt leuchtet');
    log(await w.locator('#arrow-layer .arrow-hit').count() >= 1, 'Aufgelöster Pfeil wird grün');
    log(await b.locator('#arrow-layer .arrow-hit').count() >= 1, 'Der Gegner sieht den Treffer ebenfalls');
    log(/✓/.test(await w.textContent('#history-list')), 'Treffer steht in der Zughistorie');

    // =================================================================
    console.log('\n— Item kaufen —');
    await w.click('.shop-card[data-item="freeze"]');
    await w.waitForTimeout(250);
    log(await w.locator('#target-banner:not(.hidden)').count() === 1, 'Zielmodus wird geöffnet');
    log(await w.locator('.square.target-ok').count() > 0, 'Gültige Ziele leuchten');
    log(await w.evaluate(() => document.getElementById('board-wrapper').classList.contains('targeting')),
        'Brett wird im Zielmodus abgedunkelt');

    await w.keyboard.press('Escape');
    await w.waitForTimeout(200);
    log(await w.locator('#target-banner.hidden').count() === 1, 'Esc bricht den Zielmodus ab');
    log(await w.textContent('#bottom-coins .coin-num') === '21', 'Abbruch kostet keine Münzen');

    await w.click('.shop-card[data-item="freeze"]');
    await w.waitForTimeout(200);
    await w.click(sel(0, 1));             // Springer b8 fesseln
    await w.waitForTimeout(400);
    log(await w.textContent('#bottom-coins .coin-num') === '18', 'Fesselung kostet 3 Münzen');
    log(await w.locator('#effects-mine .effect-chip').count() === 1, 'Eigener Effekt erscheint in der Leiste');
    log(await b.locator('#effects-theirs .effect-chip').count() === 1, 'Gegner sieht den Effekt ebenfalls');
    log(/shackle/i.test(await b.textContent('#effects-theirs')), 'Gegner sieht den Namen des Items');
    log(await w.locator('#shop-lock:not(.hidden)').count() === 1, 'Nach dem Kauf ist der Shop für diesen Zug zu');
    log(/one item per turn/i.test(await w.textContent('#shop-lock-reason')), 'Sperrgrund nach dem Kauf stimmt');

    // Der gefesselte Springer darf nicht ziehen
    await move(w, [7, 6], [5, 5]);        // Sg1–f3
    await b.click(sel(0, 1));
    await b.waitForTimeout(200);
    log(await b.locator('.square.valid-move, .square.capture-move').count() === 0,
        'Gefesselter Springer bietet keine Züge an');

    // =================================================================
    console.log('\n— Nebel des Krieges —');
    await move(b, [1, 3], [2, 3]);        // d7–d6, damit Weiß wieder dran ist
    await w.waitForTimeout(300);
    await w.click('.shop-card[data-item="fog"]');
    await w.waitForTimeout(500);
    log(await w.locator('#fog-badge:not(.hidden)').count() === 1, 'Nebel-Anzeige erscheint');
    log(await w.locator('.square.fogged').count() > 0, 'Felder außerhalb der Sicht werden vernebelt');
    log(await w.evaluate(() => {
        const img = document.querySelector('#board .square[data-r="0"][data-c="0"] .piece-img');
        return img.classList.contains('hidden');
    }), 'Gegnerischer Turm a8 ist nicht gerendert');
    log(await w.evaluate(() => !window.__leak), 'Kein Leak-Flag gesetzt');

    // =================================================================
    console.log('\n— Konsolenfehler —');
    if (errors.length) errors.slice(0, 10).forEach(e => console.error('   ' + e));
    log(errors.length === 0, `Keine internen JS-Fehler (${errors.length})`);

    await browser.close();
    console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('\nUI-Test abgebrochen:', err);
    process.exit(1);
});
