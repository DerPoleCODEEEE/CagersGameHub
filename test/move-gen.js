/**
 * Tests für die isomorphe Zuggenerierung.
 *
 * Diese Datei ist bewusst abhängigkeitsfrei — `npm test` läuft ohne
 * zusätzliche Installation.
 *
 *   node test/move-gen.test.js
 */
'use strict';

const assert = require('assert');
const MG = require('../public/shared/move-gen.js');

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error(`       ${err.message}`);
    }
}

function emptyBoard() {
    return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function emptyMutantBoard() {
    return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function has(moves, r, c, type) {
    return moves.some(m => m.r === r && m.c === c && (type === undefined || m.type === type));
}

console.log('\n— Bounds & Eingabevalidierung —');

test('classicMoves lehnt Indizes ausserhalb des Bretts ab', () => {
    const b = MG.createInitialBoard();
    assert.deepStrictEqual(MG.classicMoves(b, 99, 0), []);
    assert.deepStrictEqual(MG.classicMoves(b, -1, 0), []);
    assert.deepStrictEqual(MG.classicMoves(b, 0, 8), []);
    assert.deepStrictEqual(MG.classicMoves(b, 1.5, 0), []);
    assert.deepStrictEqual(MG.classicMoves(b, '0', 0), []);
    assert.deepStrictEqual(MG.classicMoves(b, null, 0), []);
});

test('mutantMoves lehnt Indizes ausserhalb des Bretts ab', () => {
    const b = MG.createInitialMutantBoard();
    assert.deepStrictEqual(MG.mutantMoves(b, 99, 0), []);
    assert.deepStrictEqual(MG.mutantMoves(b, 0, -3), []);
    assert.deepStrictEqual(MG.mutantMoves(b, NaN, 0), []);
});

test('validCoords erkennt gueltige und ungueltige Koordinaten', () => {
    assert.strictEqual(MG.validCoords(0, 0, 7, 7), true);
    assert.strictEqual(MG.validCoords(0, 0, 7, 8), false);
    assert.strictEqual(MG.validCoords(0, 0, 7, undefined), false);
});

console.log('\n— Klassische Zugregeln —');

test('Bauer: Doppelschritt nur von der Grundreihe', () => {
    const b = MG.createInitialBoard();
    const fromStart = MG.classicMoves(b, 6, 4);
    assert.ok(has(fromStart, 5, 4, 'normal'), 'Einzelschritt fehlt');
    assert.ok(has(fromStart, 4, 4, 'normal'), 'Doppelschritt fehlt');

    const b2 = emptyBoard();
    b2[5][4] = 'P';
    const moved = MG.classicMoves(b2, 5, 4);
    assert.ok(has(moved, 4, 4, 'normal'));
    assert.ok(!has(moved, 3, 4), 'Doppelschritt darf hier nicht erlaubt sein');
});

test('Bauer: En Passant nur gegen das gesetzte Zielfeld', () => {
    const b = emptyBoard();
    b[3][4] = 'P';
    b[3][5] = 'p';
    const ep = { r: 2, c: 5, color: 'b' };
    const moves = MG.classicMoves(b, 3, 4, { enPassantTarget: ep });
    assert.ok(has(moves, 2, 5, 'en_passant'), 'En Passant fehlt');

    const ohne = MG.classicMoves(b, 3, 4, { enPassantTarget: null });
    assert.ok(!has(ohne, 2, 5), 'Ohne Ziel darf es kein En Passant geben');
});

test('Turm wird von der eigenen Figur blockiert', () => {
    const b = emptyBoard();
    b[7][0] = 'R';
    b[7][3] = 'P';
    b[4][0] = 'p';
    const moves = MG.classicMoves(b, 7, 0);
    assert.ok(has(moves, 7, 1) && has(moves, 7, 2));
    assert.ok(!has(moves, 7, 3), 'Eigene Figur darf nicht geschlagen werden');
    assert.ok(!has(moves, 7, 4));
    assert.ok(has(moves, 4, 0, 'capture'), 'Gegnerische Figur muss schlagbar sein');
    assert.ok(!has(moves, 3, 0), 'Hinter dem Schlagziel ist Schluss');
});

test('Rochade: nur mit unbewegtem Koenig und Turm sowie freier Reihe', () => {
    const b = emptyBoard();
    b[7][4] = 'K'; b[7][7] = 'R'; b[7][0] = 'R';
    const hm = MG.createHasMoved();

    const ok = MG.classicMoves(b, 7, 4, { hasMoved: hm });
    assert.ok(has(ok, 7, 6, 'castle'), 'Kurze Rochade fehlt');
    assert.ok(has(ok, 7, 2, 'castle'), 'Lange Rochade fehlt');

    const hmMoved = MG.createHasMoved();
    hmMoved.wK = true;
    assert.ok(!has(MG.classicMoves(b, 7, 4, { hasMoved: hmMoved }), 7, 6),
        'Nach Koenigszug darf nicht rochiert werden');

    const blocked = emptyBoard();
    blocked[7][4] = 'K'; blocked[7][7] = 'R'; blocked[7][5] = 'B';
    assert.ok(!has(MG.classicMoves(blocked, 7, 4, { hasMoved: MG.createHasMoved() }), 7, 6),
        'Besetztes Feld muss die Rochade verhindern');
});

test('updateCastlingRights: Turmzug UND geschlagener Turm entziehen das Recht', () => {
    const hm = MG.createHasMoved();
    MG.updateCastlingRights(hm, 'R', 7, 0, 5, 0);
    assert.strictEqual(hm.wR_left, true);

    const hm2 = MG.createHasMoved();
    // Schwarzer Turm schlaegt auf h1 -> Weiss verliert die kurze Rochade
    MG.updateCastlingRights(hm2, 'r', 0, 7, 7, 7);
    assert.strictEqual(hm2.wR_right, true);
});

test('Springer springt ueber Figuren, bleibt aber im Brett', () => {
    const b = MG.createInitialBoard();
    const moves = MG.classicMoves(b, 7, 1);
    assert.ok(has(moves, 5, 0) && has(moves, 5, 2));
    assert.strictEqual(moves.length, 2, 'Nur zwei legale Springerzuege im Startbrett');
    moves.forEach(m => {
        assert.ok(m.r >= 0 && m.r < 8 && m.c >= 0 && m.c < 8);
    });
});

console.log('\n— Mutant Merge —');

test('Fusion: identische Figurentypen sind verboten', () => {
    const res = MG.checkMergeLegality(['N'], ['N'], true, 3);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /identical/i);
});

test('Fusion: Dame + Turm/Laeufer ist redundant und verboten', () => {
    assert.strictEqual(MG.checkMergeLegality(['Q'], ['R'], true, 3).ok, false);
    assert.strictEqual(MG.checkMergeLegality(['Q'], ['B'], true, 3).ok, false);
    assert.strictEqual(MG.checkMergeLegality(['Q'], ['P'], true, 3).ok, false);
});

test('Fusion: Koenig respektiert allowKingFusion', () => {
    assert.strictEqual(MG.checkMergeLegality(['K'], ['N'], true, 3).ok, true);
    assert.strictEqual(MG.checkMergeLegality(['K'], ['N'], false, 3).ok, false);
    assert.strictEqual(MG.checkMergeLegality(['K'], ['P'], true, 3).ok, false);
});

test('Fusion: ohne verbleibende Fusionen nicht moeglich', () => {
    assert.strictEqual(MG.checkMergeLegality(['N'], ['B'], true, 0).ok, false);
    assert.strictEqual(MG.checkMergeLegality(['N'], ['B'], true, 1).ok, true);
});

test('Fusion: bereits fusionierte Figuren koennen nicht erneut fusionieren', () => {
    assert.strictEqual(MG.checkMergeLegality(['Q_fused'], ['N'], true, 3).ok, false);
    assert.strictEqual(MG.checkMergeLegality(['N'], ['Q_fused'], true, 3).ok, false);
});

test('Fusion: maximal zwei Figuren pro Feld', () => {
    assert.strictEqual(MG.checkMergeLegality(['N', 'B'], ['R'], true, 3).ok, false);
});

test('mutantMoves erzeugt merge-Zug nur bei erlaubter Kombination', () => {
    const b = emptyMutantBoard();
    b[4][4] = ['N'];
    b[4][6] = ['B'];
    b[2][4] = ['N'];   // gleicher Typ -> kein Merge

    const moves = MG.mutantMoves(b, 4, 4, { fusionsLeft: { w: 3, b: 3 }, allowKingFusion: true });
    // Springer von e4: erreicht u.a. d6/f6/... — pruefe die Merge-Logik ueber Turm
    const rookBoard = emptyMutantBoard();
    rookBoard[4][4] = ['R'];
    rookBoard[4][6] = ['B'];
    const rookMoves = MG.mutantMoves(rookBoard, 4, 4, { fusionsLeft: { w: 3, b: 3 }, allowKingFusion: true });
    assert.ok(has(rookMoves, 4, 6, 'merge'), 'R+B muss fusionierbar sein');

    const sameBoard = emptyMutantBoard();
    sameBoard[4][4] = ['R'];
    sameBoard[4][6] = ['R'];
    const sameMoves = MG.mutantMoves(sameBoard, 4, 4, { fusionsLeft: { w: 3, b: 3 }, allowKingFusion: true });
    assert.ok(!has(sameMoves, 4, 6), 'R+R darf kein Zug sein');
    void moves;
});

test('mutantMoves: Mutantenfigur erbt alle Gangarten, aber ohne Duplikate', () => {
    const b = emptyMutantBoard();
    b[4][4] = ['N', 'R'];
    const moves = MG.mutantMoves(b, 4, 4, { fusionsLeft: { w: 0, b: 0 } });
    assert.ok(has(moves, 2, 3), 'Springerzug fehlt');
    assert.ok(has(moves, 4, 0), 'Turmzug fehlt');
    const keys = moves.map(m => `${m.r}-${m.c}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'Es darf keine doppelten Zielfelder geben');
});

test('sortCanonically ordnet nach Figurenwert', () => {
    assert.deepStrictEqual(MG.sortCanonically(['R', 'N']), ['N', 'R']);
    assert.deepStrictEqual(MG.sortCanonically(['K', 'P']), ['P', 'K']);
});

test('getPieceColor erkennt Farbe und ungueltige Eingaben', () => {
    assert.strictEqual(MG.getPieceColor(['R']), 'w');
    assert.strictEqual(MG.getPieceColor(['r']), 'b');
    assert.strictEqual(MG.getPieceColor(null), null);
    assert.strictEqual(MG.getPieceColor([]), null);
});

console.log('\n— Client/Server-Parität —');

test('Dieselbe Eingabe liefert immer dasselbe Ergebnis (Determinismus)', () => {
    const b = MG.createInitialBoard();
    const opts = { hasMoved: MG.createHasMoved(), enPassantTarget: null };
    const a = MG.classicMoves(b, 7, 1, opts);
    const c = MG.classicMoves(b, 7, 1, opts);
    assert.deepStrictEqual(a, c);
});

test('Der Generator mutiert das Brett nicht', () => {
    const b = MG.createInitialBoard();
    const snapshot = JSON.stringify(b);
    MG.classicMoves(b, 6, 4, { hasMoved: MG.createHasMoved() });
    MG.classicMoves(b, 7, 1);
    assert.strictEqual(JSON.stringify(b), snapshot);

    const mb = MG.createInitialMutantBoard();
    const msnap = JSON.stringify(mb);
    MG.mutantMoves(mb, 6, 4, { fusionsLeft: { w: 3, b: 3 } });
    assert.strictEqual(JSON.stringify(mb), msnap);
});

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed === 0 ? 0 : 1);
