# Partee Golf — Contexto del proyecto

## Quien soy y como trabajo
Carlos ("El Profeta"), unico desarrollador y dueno de Partee Golf
(partee.com.mx). Comunico en espanol mexicano terso. "Dale"/"vamos"/
"seguimos" = ejecuta de inmediato sin pedir confirmacion.
Alta delegacion: confio en tu juicio tecnico. Pide explicacion detallada
solo cuando hay trade-offs reales que evaluar.

## Arquitectura
SPA React de un solo archivo (public/index.html), JSX via Babel en
runtime, sin build step, CRLF line endings. NO cambiar esta arquitectura
sin discutirlo explicitamente conmigo primero.

- Backend: Supabase, proyecto yuyifyflsnxnwasobnqg
- Hosting: Vercel, team team_RNN0FD9kvKAgQy9L8kOG6YAs,
  proyecto prj_tQZlpDANsikWJEAHA5u1konQtPhf
- Repo: GitHub Carlos-Garza67/ParTee-ALFA
- Pagos: Stripe (TEST — pendiente pasar a LIVE, ver docs/decisiones/)
- Email: Resend (reservas@partee.com.mx)
- Ahora tambien: app Android via TWA (Trusted Web Activity),
  package com.partee.golf, wrapea www.partee.com.mx/?app=1

## Reglas de edicion NO NEGOCIABLES
- El archivo usa CRLF. Nunca introducir LF puro al editar.
- Build marker en linea 18 (console.log Build vXX.YY), mas nuevo
  primero, ASCII plano (sin acentos, comillas dobles, ni backticks
  DENTRO del marcador — el resto de la UI si usa acentos).
- Validar SIEMPRE con tools/validate2.js antes de dar por bueno
  cualquier cambio (Babel parse + conteo de statements contra baseline).
- Correr tools/smoke.js despues de validate2.js (render jsdom).
- Baseline actual de statements: 276 (desde build v33.29, 24-ago-2026:
  +1 por SelectField, el dropdown homologado que reemplazo los 31 select
  nativos visibles. Historial: 275 en v33.28 (+DateField), 274 en v33.26
  (eliminado ThemeToggle duplicado), 275 confirmado 18-ago-2026 sobre
  v33.21 commit dd2121b tras limpieza — ver "Historial de limpieza").
  Sube con cada feature nueva — no es un valor fijo, es el conteo
  esperado DESPUES del ultimo cambio aceptado. Si un cambio tuyo hace
  que el conteo baje sin que hayas borrado codigo a proposito, sospecha
  antes de continuar.
- rep1()-style: cualquier reemplazo de texto debe tener contexto
  unico. Si un ancla de texto se repite en el archivo, un replace
  puede tocar la instancia equivocada — verificar unicidad antes
  de aplicar (contar ocurrencias del string exacto en todo el
  archivo, no solo asumir por la vista local del editor).
- NUNCA declarar la misma funcion/componente dos veces en el mismo
  scope, incluso si JS/Babel-en-navegador lo tolera silenciosamente.
  Un parser estricto (como el que usa Claude Code o cualquier linter)
  lo rechaza. Ver "Historial de limpieza" — ya paso una vez.

## Ritual de deploy y verificacion
1. Editar public/index.html
2. node tools/validate2.js public/index.html
3. node tools/smoke.js
4. Commit + push a main (yo lo hago via git, o tu via GitHub
   Desktop si prefieres seguir haciendolo manual)
5. Verificar que Vercel SI disparo deploy (el webhook a veces
   se salta pushes muy seguidos):
   curl https://raw.githubusercontent.com/Carlos-Garza67/
   ParTee-ALFA/<SHA>/public/index.html | md5sum
   -> comparar contra md5sum del archivo local
6. Si no coincide: forzar redeploy (Create Deployment manual
   o commit vacio)
7. Confirmar el build marker en el sitio vivo (www.partee.com.mx,
   canonico — el apex hace 307 a www) coincide con lo esperado.

## Bug recurrente a vigilar
Uploads de archivos pueden introducir \r\r\n dobles.
Siempre normalizar antes de trabajar: reemplazar \r\r\n por \r\n
y verificar md5 contra produccion antes de empezar cualquier sesion.

## Historial de limpieza (18-ago-2026)
Al recrear validate2.js desde cero (se perdio en un reinicio de
sandbox) y correrlo por primera vez en modo estricto contra el
build real v33.21, aparecieron 4 bugs heredados que el navegador
toleraba silenciosamente pero que un parser Babel estricto rechaza:
- GlassCard declarado 2 veces (linea vieja con React.createElement,
  linea nueva con JSX directo + fallbacks de color — la nueva ganaba
  en runtime por reasignacion de function declaration).
- WhiteSection: mismo patron exacto, mismas causas.
- Ambas duplicaciones vienen de la integracion del Brandbook
  (abril 2026) que agrego versiones nuevas sin remover las viejas.
- 2 instancias de "}" sobrante en el cierre de un `.map(po=>{...
  return(...)})` dentro de AdminPayoutsHistory (vista mobile-cards
  de liquidaciones) y un componente hermano de historial de pagos
  (bloque con b.stripe_payment_intent). Cierre correcto de ese
  patron es exactamente 4 simbolos ")})}" — cierra return(, cierra
  el arrow po=>{, cierra .map(, cierra la expresion JSX {...}.
  Tenian 5 simbolos ")})}}", uno de mas.
Los 4 fixes se aplicaron, se validaron con Babel (PASS, llaves
balanceadas 33644=33644), se subieron a produccion (commit dd2121b,
deploy dpl_Fo6i8UUhregdqE86PPbqU3ZbLBD4, confirmado en el sitio vivo).
Cero cambio de comportamiento funcional — solo codigo muerto/
desbalanceado removido. Este historial queda aqui para que, si el
baseline de statements alguna vez no cuadra contra una copia vieja
descargada, se sepa por que.

## Principio de arquitectura central
Plataformas/simuladores funcionan igual que campos tradicionales:
la logica usa facility_type !== "campo"; solo cambian etiquetas
de texto (bahia/cabina) y contadores. NO crear ramas de logica
separadas para cada tipo de instalacion.

## IDs de prueba clave
Ver docs/ids-de-prueba.md para la lista completa. TODOS los venues
en la base de datos son datos de prueba/seed, no clientes reales —
la ausencia de datos fiscales en ellos NO es una urgencia de
produccion.

## Antes de decir que algo falta o esta pendiente
SIEMPRE hacer grep en el codigo y consultar Supabase primero.
Hay historial de features que se reportaron como pendientes
cuando ya estaban implementadas (costo real de trabajo
duplicado). Verificar, no asumir. Mismo principio aplica a bugs:
antes de asumir que algo esta roto, correr el validador real y
ver el error exacto — no diagnosticar por sintoma visual.
