// smoke.js — Smoke test de render para Partee Golf
// Uso: node tools/smoke.js [public/index.html]
//
// Que hace:
//   1. Extrae el JSX de <script type="text/plain" id="jsx-source">
//   2. Lo transpila con Babel local (mismo preset que validate2.js)
//   3. Crea un DOM simulado (jsdom) con stubs de APIs de browser que
//      jsdom no trae (matchMedia, IntersectionObserver, ResizeObserver,
//      Notification, serviceWorker) y un stub de Supabase (Proxy
//      tolerante que absorbe cualquier llamada sin ir a la red).
//   4. Evalua el codigo completo en ese contexto: todas las
//      declaraciones de componentes se ejecutan y el mount
//      createRoot(...).render(<ErrorBoundary><App/></ErrorBoundary>)
//      corre de verdad sobre el DOM simulado.
//   5. PASS si el script evalua y monta sin excepcion no capturada.
//
// Lo que NO cubre: logica que depende de datos reales de Supabase,
// navegacion profunda, ni estilos. Es un canario de "la app arranca",
// no un E2E.
//
// Exit codes: 0 = PASS, 1 = FAIL

const fs = require('fs');
const babel = require('@babel/core');
const { JSDOM } = require('jsdom');

const filePath = process.argv[2] || 'public/index.html';

const html = fs.readFileSync(filePath, 'utf8');

// ---- 1. Extraer JSX ----
const startTag = '<script type="text/plain" id="jsx-source">';
const s = html.indexOf(startTag);
if (s === -1) { console.error('FAIL: no se encontro el jsx-source'); process.exit(1); }
const cs = s + startTag.length;
const e = html.indexOf('</script>', cs);
const jsx = html.slice(cs, e);

// ---- 2. Transpilar ----
// Nota: Babel imprime "[BABEL] Note: ... deoptimised the styling ... exceeds
// the max of 500KB" por el tamano del archivo — es esperado e inofensivo
// (solo desactiva el formateo bonito del output), la suprimimos del stderr.
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && chunk.includes('deoptimised the styling')) return true;
  return origWrite(chunk, ...args);
};
let code;
try {
  code = babel.transformSync(jsx, {
    presets: [require.resolve('@babel/preset-react')],
    filename: 'jsx-source.jsx',
    babelrc: false,
    configFile: false,
  }).code;
} catch (err) {
  console.error('FAIL: Babel no pudo transpilar (corre validate2.js para el detalle)');
  console.error(err.message);
  process.exit(1);
}

// ---- 3. DOM simulado + stubs ----
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'https://www.partee.com.mx/',
  pretendToBeVisual: true, // requestAnimationFrame et al.
  runScripts: 'outside-only', // habilita getInternalVMContext para evaluar el codigo
});
const { window } = dom;

// Proxy tolerante: absorbe cualquier propiedad/llamada/await sin tronar.
// Usado para el cliente de Supabase — asi el smoke corre 100% offline.
function tolerantStub() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') {
        // "thenable" que resuelve a un shape tipico de supabase-js
        return (resolve) => resolve({ data: null, error: null, count: 0 });
      }
      if (prop === Symbol.toPrimitive) return () => '';
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  });
  return proxy;
}

window.supabase = { createClient: () => tolerantStub() };

// APIs de browser que jsdom no implementa
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));
window.IntersectionObserver = window.IntersectionObserver || class {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
};
window.ResizeObserver = window.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
window.Notification = window.Notification || Object.assign(class {}, {
  permission: 'default',
  requestPermission: () => Promise.resolve('default'),
});
const swStub = {
  register: () => Promise.resolve({ scope: '/', unregister: () => Promise.resolve(true) }),
  getRegistration: () => Promise.resolve(undefined),
  getRegistrations: () => Promise.resolve([]),
  ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
  controller: null,
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(window.navigator, 'serviceWorker', { value: swStub, configurable: true });
window.scrollTo = window.scrollTo || (() => {});
window.fetch = window.fetch || (() => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve('') }));

// React local (npm), inyectado como los UMD del CDN.
// DOS sutilezas de contexto resueltas aqui (no cambiar el orden):
// (a) react-dom internamente referencia `window`/`document`/`navigator` como
//     globals de SU contexto (Node) — hay que apuntar los globals de Node al
//     window de jsdom ANTES de hacer require de react/react-dom (mismo patron
//     que usa Jest con testEnvironment jsdom).
// (b) el codigo de la app se evalua con vm.runInContext en el contexto
//     interno de jsdom, donde las referencias libres (React, ReactDOM,
//     supabase) se resuelven contra ESE global — por eso se escriben en ctx.
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.location = window.location;

const ReactLib = require('react');
const ReactDOMClient = require('react-dom/client');
const ReactDOMLegacy = require('react-dom');
const ReactDOMMerged = Object.assign({}, ReactDOMLegacy, ReactDOMClient);

const ctx = dom.getInternalVMContext();
ctx.React = ReactLib;
ctx.ReactDOM = ReactDOMMerged;
ctx.supabase = window.supabase; // por si el codigo usa `supabase` pelon ademas de window.supabase

// Silenciar el ruido esperado de consola durante el mount (la app loguea
// build markers y warnings de datos vacios); los errores REALES se
// capturan via el try/catch y via window.onerror.
const errors = [];
window.onerror = (msg, src, line, col, err) => {
  errors.push(err || new Error(String(msg)));
  return true;
};

// ---- 4. Evaluar ----
const vm = require('vm');
try {
  vm.runInContext(code, ctx, { filename: 'jsx-source.transpiled.js' });
} catch (err) {
  console.error('FAIL: excepcion al evaluar/montar');
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
  process.exit(1);
}

// Dar un tick para que efectos iniciales (useEffect) se encolen y truenen si van a tronar
setTimeout(() => {
  const root = window.document.getElementById('root');
  const mounted = root && root.children.length > 0;

  if (errors.length > 0) {
    console.error(`FAIL: ${errors.length} error(es) no capturados durante el mount:`);
    errors.slice(0, 3).forEach((er) => console.error(' -', er.message));
    process.exit(1);
  }
  if (!mounted) {
    console.error('FAIL: el root quedo vacio — la app no monto nada.');
    process.exit(1);
  }
  console.log('PASS: la app evaluo y monto sin excepciones.');
  console.log('Nodos hijos en #root:', root.children.length);
  process.exit(0);
}, 300);
