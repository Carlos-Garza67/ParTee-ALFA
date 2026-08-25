// validate2.js — Validador del JSX de Partee Golf
// Uso: node tools/validate2.js public/index.html [baseline]
//
// Que hace:
//   1. Extrae el JSX de <script type="text/plain" id="jsx-source">
//   2. Lo parsea con Babel estricto (@babel/preset-react)
//   3. Cuenta los statements de nivel superior (Program.body.length)
//   4. Compara contra el baseline (default 275, o el que pases como 2do arg)
//   5. Verifica que el archivo sea CRLF y detecta \r\r\n dobles (bug de uploads)
//
// Exit codes: 0 = PASS, 1 = FAIL (cualquier check)
//
// Historial: recreado 18-ago-2026 tras perderse en reinicios de sandbox.
// La primera corrida estricta detecto 4 bugs heredados (GlassCard y
// WhiteSection duplicados, 2 llaves sobrantes en paneles de payouts) —
// ver seccion "Historial de limpieza" en CLAUDE.md.

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const filePath = process.argv[2];
const BASELINE = parseInt(process.argv[3] || '276', 10);

if (!filePath) {
  console.error('Uso: node tools/validate2.js <archivo.html> [baseline]');
  process.exit(1);
}

const raw = fs.readFileSync(filePath);
const html = raw.toString('utf8');

let fail = false;

// ---- Check 1: CRLF y dobles \r\r\n ----
const crlfCount = (raw.toString('latin1').match(/\r\n/g) || []).length;
const doubleCr = (raw.toString('latin1').match(/\r\r\n/g) || []).length;
if (doubleCr > 0) {
  console.error(`FAIL: ${doubleCr} ocurrencias de \\r\\r\\n dobles (bug de upload). Normalizar antes de trabajar.`);
  fail = true;
}
if (crlfCount === 0) {
  console.error('FAIL: el archivo no tiene CRLF — line endings incorrectos.');
  fail = true;
}

// ---- Check 2: extraer JSX ----
const startTag = '<script type="text/plain" id="jsx-source">';
const startIdx = html.indexOf(startTag);
if (startIdx === -1) {
  console.error('FAIL: no se encontro <script type="text/plain" id="jsx-source">');
  process.exit(1);
}
const contentStart = startIdx + startTag.length;
const endIdx = html.indexOf('</script>', contentStart);
if (endIdx === -1) {
  console.error('FAIL: no se encontro el </script> de cierre del jsx-source');
  process.exit(1);
}
const jsx = html.slice(contentStart, endIdx);

// ---- Check 3: Babel parse estricto ----
let result;
try {
  result = babel.transformSync(jsx, {
    presets: [require.resolve('@babel/preset-react')],
    ast: true,
    code: false,
    filename: 'jsx-source.jsx',
    babelrc: false,
    configFile: false,
  });
} catch (e) {
  console.error('FAIL: Babel no pudo parsear el JSX');
  console.error(e.message);
  process.exit(1);
}

// ---- Check 4: baseline de statements ----
const count = result.ast.program.body.length;
if (count !== BASELINE) {
  console.error(`FAIL: statements = ${count}, baseline esperado = ${BASELINE}.`);
  console.error('  Si agregaste features a proposito, actualiza el baseline en');
  console.error('  CLAUDE.md y pasa el nuevo valor: node tools/validate2.js <archivo> <nuevo>');
  console.error('  Si NO agregaste/quitaste nada a proposito, investiga antes de continuar.');
  fail = true;
}

// ---- Check 5: balance bruto de llaves (indicativo, no autoritativo) ----
const ob = (jsx.match(/{/g) || []).length;
const cb = (jsx.match(/}/g) || []).length;

// ---- Reporte ----
if (!fail) {
  console.log('PASS: Babel parse OK');
} else {
  console.log('(parse Babel OK, pero hay checks fallidos arriba)');
}
console.log('Archivo:', filePath);
console.log('Statements de nivel superior:', count, '(baseline:', BASELINE + ')');
console.log('CRLF:', crlfCount, 'lineas |', doubleCr, 'dobles \\r\\r\\n');
console.log('Llaves { }:', ob, cb, ob === cb ? '(balanceado)' : '(DESBALANCEADO en conteo bruto — puede ser por strings, Babel es la autoridad)');

process.exit(fail ? 1 : 0);
