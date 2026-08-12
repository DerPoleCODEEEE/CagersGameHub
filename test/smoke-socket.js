/**
 * Protokoll-Smoketest gegen einen laufenden Server.
 * Prüft genau die Angriffe, die vorher funktioniert haben.
 *
 *   PORT=3111 node server.js &
 *   node test/smoke-socket.js http://localhost:3111
 */
'use strict';

const { io } = require('socket.io-client');
const URL = process.argv[2] || 'http://localhost:3111';

let passed = 0, failed = 0;
const log = (ok, name, extra) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function once(socket, event, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeout);
        socket.once(event, (data) => { clearTimeout(t); resolve(data); });
    });
}

async function serverAlive() {
    const res = await fetch(URL + '/healthz');
    return res.ok;
}

(async () => {
    console.log(`\nSmoketest gegen ${URL}\n`);
    console.log('— Quick Chess —');

    const p1 = io(URL, { transports: ['websocket'] });
    const p2 = io(URL, { transports: ['websocket'] });
    await Promise.all([once(p1, 'connect'), once(p2, 'connect')]);

    p1.emit('create_room', { playerName: 'Alice', isClassLock: true });
    const created = await once(p1, 'room_created');
    log(!!created.roomCode, 'Raum wird erstellt');
    log(/^[A-Z0-9]{6}$/.test(created.roomCode), 'Raumcode hat erwartetes Format');

    p2.emit('join_room', { roomCode: created.roomCode, playerName: 'Bob' });
    const joined = await once(p2, 'room_joined');
    log(joined.color === 'b', 'Zweiter Spieler bekommt Schwarz');
    log(!!joined.hasMoved, 'Rochade-Rechte werden beim Join mitgeschickt');

    // --- Angriff 1: Out-of-bounds -> vorher stirbt der Prozess -----------
    const errP = once(p1, 'error_msg', 3000).catch(() => null);
    p1.emit('request_move', { roomCode: created.roomCode, fromR: 99, fromC: 0, toR: 0, toC: 0 });
    await errP;
    await wait(300);
    log(await serverAlive(), 'Server überlebt fromR:99 (vorher: Prozess-Exit)');

    p1.emit('request_move', { roomCode: created.roomCode, fromR: null, fromC: 'x', toR: {}, toC: [] });
    p1.emit('request_move', 'kein-objekt');
    p1.emit('create_room', null);
    await wait(300);
    log(await serverAlive(), 'Server überlebt beliebigen Müll in der Nutzlast');

    // --- Ready & Zug ----------------------------------------------------
    p1.emit('player_ready', { roomCode: created.roomCode });
    p2.emit('player_ready', { roomCode: created.roomCode });
    await once(p1, 'start_match_countdown');
    log(true, 'Countdown startet, wenn beide bereit sind');

    // --- Angriff 2: illegaler Zug ---------------------------------------
    const illegal = once(p1, 'error_msg', 3000);
    p1.emit('request_move', { roomCode: created.roomCode, fromR: 6, fromC: 4, toR: 0, toC: 0 });
    const illegalMsg = await illegal;
    log(/illegal/i.test(illegalMsg), 'Illegaler Zug wird abgelehnt', illegalMsg);

    // --- Angriff 3: fremde Figur ziehen ---------------------------------
    const foreign = once(p1, 'error_msg', 3000);
    p1.emit('request_move', { roomCode: created.roomCode, fromR: 1, fromC: 4, toR: 3, toC: 4 });
    log(/not your piece/i.test(await foreign), 'Gegnerische Figur kann nicht bewegt werden');

    // --- Legaler Zug ----------------------------------------------------
    const applied = once(p2, 'apply_move', 3000);
    p1.emit('request_move', { roomCode: created.roomCode, fromR: 6, fromC: 4, toR: 4, toC: 4, duration: 500 });
    const move = await applied;
    log(move.toR === 4 && move.toC === 4, 'Legaler Zug wird an beide Spieler verteilt');
    log(!!move.hasMoved && move.enPassantTarget !== undefined,
        'apply_move enthält hasMoved + enPassantTarget');
    log(move.promotedTo === null, 'promotedTo wird serverseitig gesetzt (hier null)');

    // --- Angriff 4: manipulierte Beförderung & Dauer ---------------------
    const applied2 = once(p2, 'apply_move', 3000);
    p2.emit('request_move', {
        roomCode: created.roomCode, fromR: 1, fromC: 4, toR: 3, toC: 4,
        promotedTo: 'k', duration: 1e9
    });
    const move2 = await applied2;
    log(move2.promotedTo === null, 'promotedTo:"k" wird nicht durchgereicht (vorher: Desync)');
    log(move2.duration <= 3000, `duration wird geklemmt (${move2.duration}ms, vorher 1e9)`);

    // --- Angriff 5: Chat ohne Login --------------------------------------
    const chatErr = once(p1, 'error_msg', 3000).catch(() => null);
    p1.emit('send_hub_chat', { text: 'hallo', user: { name: '<img src=x onerror=alert(1)>' } });
    const chatMsg = await chatErr;
    log(/log in/i.test(chatMsg || ''), 'Chat ohne Login wird abgelehnt', chatMsg);

    p1.close(); p2.close();

    // =====================================================================
    console.log('\n— Mutant Merge —');
    const m1 = io(URL + '/mutant-chess', { transports: ['websocket'] });
    const m2 = io(URL + '/mutant-chess', { transports: ['websocket'] });
    await Promise.all([once(m1, 'connect'), once(m2, 'connect')]);

    m1.emit('create_mutant_room', { playerName: 'Alice', colorChoice: 'w', totalTime: 3, increment: 2, maxFusions: 3 });
    const mCreated = await once(m1, 'mutant_room_created');
    log(mCreated.color === 'w', 'Mutant-Raum mit gewünschter Farbe');
    log(!!mCreated.hasMoved, 'Mutant: hasMoved wird mitgeschickt');

    m2.emit('join_mutant_room', { roomCode: mCreated.roomCode, playerName: 'Bob' });
    const mJoined = await once(m2, 'mutant_room_joined');
    log(mJoined.color === 'b', 'Mutant: Beitritt funktioniert');

    m1.emit('player_ready', { roomCode: mCreated.roomCode });
    m2.emit('player_ready', { roomCode: mCreated.roomCode });
    await once(m1, 'start_match_countdown');
    log(true, 'Mutant: Countdown startet');

    // --- Angriff 6: Instant-Win (Springer schlaegt Koenig aus dem Nichts) --
    const mErr = once(m1, 'error_msg', 3000);
    m1.emit('request_mutant_move', { roomCode: mCreated.roomCode, fromR: 7, fromC: 1, toR: 0, toC: 4 });
    const mErrMsg = await mErr;
    log(/illegal/i.test(mErrMsg), 'Mutant: Instant-Win-Cheat wird abgelehnt (vorher: sofortiger Sieg)', mErrMsg);

    // --- Angriff 7: gefaelschte Rochade ----------------------------------
    const mErr2 = once(m1, 'error_msg', 3000);
    m1.emit('request_mutant_move', {
        roomCode: mCreated.roomCode, fromR: 7, fromC: 4, toR: 7, toC: 6,
        moveInfo: { r: 7, c: 6, type: 'castle' }
    });
    log(/illegal/i.test(await mErr2), 'Mutant: erfundene Rochade wird abgelehnt');

    // --- Angriff 8: nicht am Zug ------------------------------------------
    const mErr3 = once(m2, 'error_msg', 3000);
    m2.emit('request_mutant_move', { roomCode: mCreated.roomCode, fromR: 1, fromC: 4, toR: 3, toC: 4 });
    log(/not your turn/i.test(await mErr3), 'Mutant: Zug ausserhalb der Reihe wird abgelehnt');

    // --- Angriff 9: Out-of-bounds -----------------------------------------
    m1.emit('request_mutant_move', { roomCode: mCreated.roomCode, fromR: 42, fromC: -7, toR: 0, toC: 0 });
    await wait(300);
    log(await serverAlive(), 'Mutant: Server überlebt Out-of-bounds');

    // --- Legaler Mutant-Zug ------------------------------------------------
    const mApplied = once(m2, 'apply_mutant_move', 3000);
    m1.emit('request_mutant_move', { roomCode: mCreated.roomCode, fromR: 6, fromC: 4, toR: 4, toC: 4 });
    const mMove = await mApplied;
    log(mMove.nextTurn === 'b', 'Mutant: legaler Zug wechselt das Zugrecht');
    log(!!mMove.hasMoved, 'Mutant: apply_mutant_move enthält hasMoved');
    log(mMove.enPassantTarget && mMove.enPassantTarget.r === 5,
        'Mutant: En-Passant-Ziel wird serverseitig gesetzt');

    // --- Angriff 10: eigenes Remis-Angebot annehmen ------------------------
    m1.emit('offer_draw', { roomCode: mCreated.roomCode });
    await wait(200);
    const selfAccept = once(m1, 'game_over', 1200).catch(() => null);
    m1.emit('respond_draw', { roomCode: mCreated.roomCode, accepted: true });
    log((await selfAccept) === null, 'Eigenes Remis-Angebot kann man nicht selbst annehmen');

    m1.close(); m2.close();

    // =====================================================================
    console.log('\n— HTTP-API —');

    const statsRes = await fetch(URL + '/api/stats/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'chess', result: 'win' })
    });
    log(statsRes.status === 401 || statsRes.status === 403,
        `Stats-Endpunkt ohne Login abgelehnt (${statsRes.status})`);

    const search = await fetch(URL + '/api/users/search?q=' + encodeURIComponent('(a+)+$'));
    log(search.status === 503 || search.ok, `ReDoS-Query bringt den Server nicht um (${search.status})`);
    log(await serverAlive(), 'Server nach ReDoS-Versuch weiterhin erreichbar');

    const userRes = await fetch(URL + '/api/user');
    const userBody = await userRes.json();
    log(userBody === null, 'Unangemeldet liefert /api/user null');

    // =====================================================================
    // Aufräumen & Forfeit — nur sinnvoll mit verkürzten Zeiten:
    //   PORT=3111 FORFEIT_MS=3000 ROOM_GRACE_MS=4000 node server.js
    // =====================================================================
    const fast = process.env.FAST_CLEANUP === '1';
    if (fast) {
        console.log('\n— Forfeit & Raum-Aufräumung —');

        const f1 = io(URL, { transports: ['websocket'] });
        const f2 = io(URL, { transports: ['websocket'] });
        await Promise.all([once(f1, 'connect'), once(f2, 'connect')]);

        f1.emit('create_room', { playerName: 'A' });
        const fRoom = await once(f1, 'room_created');
        f2.emit('join_room', { roomCode: fRoom.roomCode, playerName: 'B' });
        await once(f2, 'room_joined');
        f1.emit('player_ready', { roomCode: fRoom.roomCode });
        f2.emit('player_ready', { roomCode: fRoom.roomCode });
        await once(f1, 'start_match_countdown');

        const over = once(f2, 'game_over', 8000);
        f1.close();   // Weiß verlässt die Partie
        const result = await over;
        log(result.winnerColor === 'b' && result.reason === 'disconnect',
            'Disconnect führt zum Forfeit-Sieg des Gegners');
        f2.close();

        const before = await (await fetch(URL + '/healthz')).json();
        log(before.rooms.chess > 0, `Räume sind währenddessen belegt (${before.rooms.chess})`);
        await wait(9000);
        const after = await (await fetch(URL + '/healthz')).json();
        log(after.rooms.chess === 0 && after.rooms.mutant === 0,
            `Beendete Räume werden gelöscht (vorher: nie) — chess:${after.rooms.chess} mutant:${after.rooms.mutant}`);
    } else {
        console.log('\n(Forfeit-/Aufräumtests übersprungen — mit FAST_CLEANUP=1 und kurzen Serverzeiten aktivieren)');
    }

    console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('\nSmoketest abgebrochen:', err.message);
    process.exit(1);
});
