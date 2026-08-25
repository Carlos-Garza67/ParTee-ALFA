// v20.7 + v20.16 + v20.94 + v20.105 + v21.42 + v21.43 + v33.39: generate-weekly-insight v7
//
// v7 (ago25/2026): BILINGUE. El body acepta lang ("es"|"en", default "es") — el frontend lo manda
//   desde v33.38 al presionar Regenerar con el idioma de la sesion del admin. El idioma aplica a:
//   la narrativa Claude (instruccion de idioma en el system prompt), el template deterministico
//   de fallback, y el correo (labels, hero, subject, rango de fechas). Cuando llama el cron sin
//   lang, la funcion intenta leer courses.preferred_lang (si la columna existe; si no, sigue en
//   espanol sin fallar — migracion opcional: ALTER TABLE courses ADD COLUMN preferred_lang text).
//   El idioma usado se guarda en kpi_snapshot._lang (informativo, sin migracion de esquema).
//   Los labels de best/worst day se recalculan del date con el locale del idioma.
//
// v6 (jun12/2026): El correo semanal ahora es NUMBERS-FIRST. En vez de renderizar la narrativa
//   markdown, el email arma rejillas de KPIs (ingresos/reservas/ticket con delta vs semana previa,
//   jugadores/cancelaciones/promos, comparativa, dias destacados, top jugadores, VIPs inactivos),
//   todo en cifras con texto minimo. La narrativa (Claude/template) se sigue generando y guardando
//   en admin_weekly_insights para el dashboard; ya no se manda en el correo. Solo cambia el render
//   del email (renderInsightEmail recibe los KPIs); generacion/auth/cron/prefs/recipient identicos.
//
// v5 (jun12): correo branded (kit de send-email v30: logo + hero icono + tarjetas).
// v4 (v20.105, jun08): DIAGNOSTIC — expone has_anthropic_key + fallback_reason.
// v3 (v20.94, jun06): FIX env var name (CRON_SECRET || PARTEE_CRON_SECRET).
// v2 (v20.16): después de save, envía email al course-admin via Resend si pref on + Resend configurado.
// v1: genera insight semanal narrativo (Claude Haiku 4.5 o template determinístico).
//
// Auth: Authorization Bearer (course_admin/platform_admin) o X-Partee-Cron-Secret.
// Body: { course_id: uuid, week_start?: 'YYYY-MM-DD', force?: bool, skip_email?: bool, lang?: 'es'|'en' }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CRON_SECRET = Deno.env.get("CRON_SECRET") || Deno.env.get("PARTEE_CRON_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "reservas@partee.com.mx";
const FROM_NAME = Deno.env.get("FROM_NAME") || "Partee Golf";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-partee-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type Lang = "es" | "en";

interface Kpis {
  course_name: string;
  week_start: string;
  week_end: string;
  current: { bookings: number; unique_users: number; revenue: number; cancellations: number; aov: number };
  previous_week: { bookings: number; revenue: number; revenue_delta_pct: number | null; bookings_delta_pct: number | null };
  month_ago_week: { bookings: number; revenue: number; revenue_delta_pct: number | null };
  best_day: { date: string; label: string; bookings: number; revenue: number } | null;
  worst_day: { date: string; label: string; bookings: number; revenue: number } | null;
  top_customers: Array<{ user_id: string; name: string; bookings: number; revenue: number }>;
  inactive_vips: Array<{ user_id: string; name: string; rev_12mo: number; days_inactive: number }>;
  promos: { redemptions: number; total_discount: number };
}

const fmtMxn = (n: number) => "$" + Math.round(n || 0).toLocaleString("es-MX");

// v7: label de dia recalculado del date con el locale del idioma (el RPC lo manda en espanol)
function dayLabel(d: { date: string; label: string } | null, lang: Lang): string {
  if (!d) return "";
  if (lang === "en" && d.date) {
    try { return new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }); } catch (_e) { /* fallback below */ }
  }
  return d.label;
}

function generateTemplateInsight(k: Kpis, lang: Lang): string {
  const lines: string[] = [];
  const en = lang === "en";
  lines.push(en
    ? `## ${k.course_name} — Week of ${k.week_start} to ${k.week_end}`
    : `## ${k.course_name} — Semana del ${k.week_start} al ${k.week_end}`);
  lines.push("");
  const rev = fmtMxn(k.current.revenue);
  const prevDelta = k.previous_week.revenue_delta_pct;
  const monthDelta = k.month_ago_week.revenue_delta_pct;
  let revLine = en
    ? `**Revenue: ${rev}** with ${k.current.bookings} bookings`
    : `**Revenue: ${rev}** con ${k.current.bookings} reservas`;
  if (prevDelta !== null && prevDelta !== undefined) revLine += en
    ? `, ${prevDelta >= 0 ? "+" : ""}${prevDelta}% vs last week`
    : `, ${prevDelta >= 0 ? "+" : ""}${prevDelta}% vs semana anterior`;
  if (monthDelta !== null && monthDelta !== undefined) revLine += en
    ? `, ${monthDelta >= 0 ? "+" : ""}${monthDelta}% vs same week last month`
    : `, ${monthDelta >= 0 ? "+" : ""}${monthDelta}% vs misma semana mes pasado`;
  revLine += ".";
  lines.push(revLine);
  lines.push("");
  if (k.best_day) lines.push(en
    ? `Your best day was **${dayLabel(k.best_day, lang)}** (${fmtMxn(k.best_day.revenue)}, ${k.best_day.bookings} bookings).`
    : `Tu mejor día fue **${dayLabel(k.best_day, lang)}** (${fmtMxn(k.best_day.revenue)}, ${k.best_day.bookings} reservas).`);
  if (k.worst_day && k.worst_day.date !== k.best_day?.date) lines.push(en
    ? `Your slowest day was **${dayLabel(k.worst_day, lang)}** (${fmtMxn(k.worst_day.revenue)}, ${k.worst_day.bookings} bookings) — consider a promo for that window.`
    : `Tu peor día fue **${dayLabel(k.worst_day, lang)}** (${fmtMxn(k.worst_day.revenue)}, ${k.worst_day.bookings} reservas) — considera una promoción para esa franja.`);
  lines.push("");
  if (k.top_customers && k.top_customers.length > 0) {
    lines.push(en ? "### Top players of the week" : "### Top jugadores de la semana");
    k.top_customers.forEach(c => lines.push(en
      ? `- **${c.name}**: ${c.bookings} booking${c.bookings === 1 ? "" : "s"} · ${fmtMxn(c.revenue)}`
      : `- **${c.name}**: ${c.bookings} reserva${c.bookings === 1 ? "" : "s"} · ${fmtMxn(c.revenue)}`));
    lines.push("");
  }
  if (k.inactive_vips && k.inactive_vips.length > 0) {
    lines.push(en ? "### ⚠️ VIPs gone quiet" : "### ⚠️ VIPs sin venir últimamente");
    k.inactive_vips.slice(0, 3).forEach(v => lines.push(en
      ? `- **${v.name}** (${fmtMxn(v.rev_12mo)} LTV) — ${v.days_inactive} days without booking`
      : `- **${v.name}** (${fmtMxn(v.rev_12mo)} LTV) — ${v.days_inactive} días sin reservar`));
    lines.push("");
    lines.push(en
      ? "_Tip: a personal call or email can win them back._"
      : "_Sugerencia: una llamada o email personal puede recuperarlos._");
    lines.push("");
  }
  if (k.promos && k.promos.redemptions > 0) {
    lines.push(en
      ? `This week **${k.promos.redemptions} promo${k.promos.redemptions === 1 ? "** was" : "s** were"} redeemed with a total discount of ${fmtMxn(k.promos.total_discount)}.`
      : `Esta semana se redimieron **${k.promos.redemptions} promociones** con un descuento total de ${fmtMxn(k.promos.total_discount)}.`);
    lines.push("");
  }
  if (k.current.cancellations > 0) {
    lines.push(en
      ? `There ${k.current.cancellations === 1 ? "was 1 cancellation" : `were ${k.current.cancellations} cancellations`} this week.`
      : `Hubo ${k.current.cancellations} cancelación${k.current.cancellations === 1 ? "" : "es"} esta semana.`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function generateClaudeInsight(k: Kpis, lang: Lang): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const langLine = lang === "en"
    ? "Write the ENTIRE insight in neutral English (headers, labels, day names, everything — translate day labels that come in Spanish in the JSON)."
    : "Escribes en español neutro.";
  const systemPrompt = `Eres un analista de operaciones de Partee Golf, plataforma de tee times en México. Generas insights ejecutivos semanales para el course-admin de un campo de golf. ${langLine} Tono profesional pero cercano. Usa markdown ligero (**bold**, listas con -). Máximo 250 palabras. FORMATO FIJO de encabezados: la primera línea es el título del reporte y empieza EXACTAMENTE con "## " (dos numerales); cada encabezado de sección empieza EXACTAMENTE con "### " (tres numerales). NUNCA uses "# " (un solo numeral) ni otros niveles. Estructura: 1) titular ejecutivo con revenue + delta, 2) días destacados (best/worst), 3) top jugadores, 4) alertas de retención si hay VIPs inactivos, 5) UNA recomendación accionable concreta al final. No uses emojis excepto ⚠️ para alertas. No inventes datos que no estén en el JSON.`;
  const userPrompt = `Genera el insight semanal para este campo:\n\n${JSON.stringify(k, null, 2)}`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
  });
  if (!resp.ok) throw new Error(`Claude API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error("Claude response missing text content");
  return text.trim();
}

// ===== Partee branded email kit (espejo byte-a-byte de send-email v30) =====
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const CLR = {
  green: '#00b894', red: '#e94560', navy: '#0f3460', ink: '#13131f',
  bg: '#eceef1', card: '#ffffff', border: '#e6e8ec',
  text: '#1f2937', muted: '#6b7280', faint: '#9aa1ac',
};
const APP = 'https://www.partee.com.mx';
const ASSET = 'https://yuyifyflsnxnwasobnqg.supabase.co/storage/v1/object/public/email-assets';
const MARK = `${ASSET}/mark.png`;
const HERO_ICONS = new Set([
  'flag', 'receipt', 'refund', 'medal', 'renew', 'calendar', 'bolt', 'chart', 'money',
  'bell', 'users', 'xcircle', 'warning', 'userplus', 'clock', 'card', 'swords', 'trophy',
  'clipboard', 'checkcircle', 'pencil', 'ban', 'document'
]);

function esc(s: string) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function btn(label: string, href: string, bg: string = CLR.green) {
  return `<a href="${href}" style="display:block;text-align:center;padding:14px 16px;background:${bg};color:#ffffff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;font-family:${FONT};margin:8px 0">${esc(label)}</a>`;
}
function rows(items: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${items}</table>`;
}
function row(label: string, valueHtml: string) {
  return `<tr><td style="padding:9px 0;color:${CLR.muted};font-size:13px;border-top:1px solid #f1f3f5;font-family:${FONT}">${esc(label)}</td><td style="padding:9px 0;text-align:right;border-top:1px solid #f1f3f5;font-family:${FONT};font-weight:600;color:#111827;font-size:13px">${valueHtml}</td></tr>`;
}
function card(inner: string, borderColor: string = CLR.border) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr><td style="background:${CLR.card};border:1px solid ${borderColor};border-radius:16px;padding:20px">${inner}</td></tr></table>`;
}
function hero(icon: string, title: string, sub = '') {
  let ic = '';
  if (icon && HERO_ICONS.has(icon)) {
    ic = `<img src="${ASSET}/icon-${icon}.png" width="44" height="44" alt="" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none">`;
  } else if (icon) {
    ic = `<div style="font-size:40px;line-height:1">${icon}</div>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:4px 4px 18px">${ic}<div style="font-size:22px;font-weight:800;color:${CLR.ink};margin-top:8px;font-family:${FONT};letter-spacing:-0.01em">${esc(title)}</div>${sub ? `<div style="font-size:13px;color:${CLR.muted};margin-top:5px;font-family:${FONT}">${esc(sub)}</div>` : ''}</td></tr></table>`;
}
function shell(body: string, preheader = '') {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><meta name="x-apple-disable-message-reformatting"><title>Partee</title></head><body style="margin:0;padding:0;background:${CLR.bg};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%">${preheader ? `<div style="display:none;max-height:0px;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CLR.bg}"><tr><td align="center" style="padding:22px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;margin:0 auto"><tr><td style="padding:2px 2px 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="${MARK}" width="34" height="32" alt="" style="display:block;border:0;outline:none;text-decoration:none"></td><td style="vertical-align:middle;padding-left:8px"><span style="font-size:25px;font-weight:800;color:${CLR.ink};font-family:${FONT};letter-spacing:-0.02em">Partee</span></td></tr></table></td></tr><tr><td>${body}</td></tr><tr><td style="padding:20px 8px 4px" align="center"><p style="margin:0;color:${CLR.faint};font-size:11px;line-height:1.7;font-family:${FONT}">Partee Golf &middot; <a href="${APP}" style="color:${CLR.faint};text-decoration:underline">partee.com.mx</a><br>Reservas, juego y operacion de campos de golf en Mexico</p></td></tr></table></td></tr></table></body></html>`;
}

// ===== helpers numbers-first del resumen semanal =====
// v7: diccionario de labels del correo por idioma
const EMAIL_L = {
  es: {
    ingresos: 'INGRESOS', reservas: 'RESERVAS', ticket: 'TICKET PROM.', jugadores: 'JUGADORES',
    cancelac: 'CANCELAC.', promos: 'PROMOS', comparativa: 'COMPARATIVA', semAnterior: 'Semana anterior',
    mismoPeriodo: 'Mismo periodo mes pasado', diasDestacados: 'DÍAS DESTACADOS', mejor: 'Mejor',
    masFloja: 'Más floja', topJugadores: 'TOP JUGADORES', vipsSinVenir: 'VIPs SIN VENIR',
    dias: 'días', res: 'res', resumenSemanal: 'Tu resumen semanal', abrirDash: 'Abrir Dashboard',
    subj: (course: string, ws: string) => `Tu resumen semanal · ${course} (sem. del ${ws})`,
    pre: (course: string) => `Tu resumen semanal de ${course}`,
  },
  en: {
    ingresos: 'REVENUE', reservas: 'BOOKINGS', ticket: 'AVG TICKET', jugadores: 'PLAYERS',
    cancelac: 'CANCELS', promos: 'PROMOS', comparativa: 'COMPARISON', semAnterior: 'Previous week',
    mismoPeriodo: 'Same period last month', diasDestacados: 'HIGHLIGHT DAYS', mejor: 'Best',
    masFloja: 'Slowest', topJugadores: 'TOP PLAYERS', vipsSinVenir: 'VIPs GONE QUIET',
    dias: 'days', res: 'bkgs', resumenSemanal: 'Your weekly summary', abrirDash: 'Open Dashboard',
    subj: (course: string, ws: string) => `Your weekly summary · ${course} (week of ${ws})`,
    pre: (course: string) => `Your weekly summary for ${course}`,
  },
} as const;

function weekRangeLabel(ws: string, we: string, lang: Lang): string {
  const o = { day: 'numeric', month: 'short' } as const;
  const loc = lang === 'en' ? 'en-US' : 'es-MX';
  const a = new Date(ws + 'T12:00:00').toLocaleDateString(loc, o);
  const b = new Date(we + 'T12:00:00').toLocaleDateString(loc, o);
  return `${a} – ${b}`;
}
function deltaChip(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '';
  const up = Number(pct) >= 0;
  const color = up ? '#059669' : '#dc2626';
  const arrow = up ? '▲' : '▼';
  return `<span style="font-size:11px;font-weight:700;color:${color};font-family:${FONT}">${arrow} ${up ? '+' : ''}${pct}%</span>`;
}
function statCell(label: string, value: string, subHtml: string, valueColor: string): string {
  return `<td width="33%" valign="top" style="background:#f6f7f9;border:1px solid ${CLR.border};border-radius:12px;padding:14px 8px;text-align:center">` +
    `<div style="font-size:10px;color:${CLR.muted};font-weight:700;letter-spacing:.5px;font-family:${FONT}">${esc(label)}</div>` +
    `<div style="font-size:21px;color:${valueColor};font-weight:800;margin-top:6px;font-family:${FONT}">${esc(value)}</div>` +
    (subHtml ? `<div style="margin-top:3px">${subHtml}</div>` : '') +
    `</td>`;
}
function grid3(a: string, b: string, c: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px"><tr>${a}<td width="10"></td>${b}<td width="10"></td>${c}</tr></table>`;
}
function threeColRow(left: string, mid: string, right: string, first: boolean, rightColor: string): string {
  const bt = first ? '0' : '1px solid #f1f3f5';
  return `<tr><td style="padding:8px 0;border-top:${bt};font-size:13px;color:#111827;font-weight:600;font-family:${FONT}">${left}</td><td style="padding:8px 0;border-top:${bt};text-align:center;font-size:12px;color:${CLR.muted};font-family:${FONT}">${mid}</td><td style="padding:8px 0;border-top:${bt};text-align:right;font-size:13px;color:${rightColor};font-weight:700;font-family:${FONT}">${right}</td></tr>`;
}

// v21.43: render numbers-first del resumen semanal (a partir de los KPIs). v7: bilingue via L.
function renderInsightEmail(courseName: string, kpis: Kpis, lang: Lang): string {
  const k = kpis;
  const L = EMAIL_L[lang];
  const cur: any = k.current || {};
  const prev: any = k.previous_week || {};
  const mon: any = k.month_ago_week || {};

  const pill = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:0 0 14px"><span style="display:inline-block;background:#eef1f4;border:1px solid ${CLR.border};border-radius:999px;padding:5px 14px;font-size:12px;color:${CLR.muted};font-weight:600;font-family:${FONT}">${esc(weekRangeLabel(k.week_start, k.week_end, lang))}</span></td></tr></table>`;

  const grid1 = grid3(
    statCell(L.ingresos, fmtMxn(cur.revenue), deltaChip(prev?.revenue_delta_pct), CLR.green),
    statCell(L.reservas, String(cur.bookings ?? 0), deltaChip(prev?.bookings_delta_pct), CLR.ink),
    statCell(L.ticket, fmtMxn(cur.aov), '', CLR.ink)
  );

  const promoSub = (k.promos?.total_discount)
    ? `<span style="font-size:11px;color:${CLR.muted};font-family:${FONT}">-${esc(fmtMxn(k.promos.total_discount))}</span>`
    : '';
  const grid2 = grid3(
    statCell(L.jugadores, String(cur.unique_users ?? 0), '', CLR.ink),
    statCell(L.cancelac, String(cur.cancellations ?? 0), '', cur.cancellations > 0 ? '#dc2626' : CLR.ink),
    statCell(L.promos, String(k.promos?.redemptions ?? 0), promoSub, CLR.ink)
  );

  const comparativa = card(
    `<div style="font-size:11px;color:${CLR.muted};font-weight:700;letter-spacing:.5px;margin-bottom:4px;font-family:${FONT}">${L.comparativa}</div>` +
    rows(
      row(L.semAnterior, `${esc(fmtMxn(prev?.revenue))} · ${prev?.bookings ?? 0} ${L.res}`) +
      row(L.mismoPeriodo, `${esc(fmtMxn(mon?.revenue))} &nbsp;${deltaChip(mon?.revenue_delta_pct)}`)
    )
  );

  const bw = (k.best_day || k.worst_day) ? card(
    `<div style="font-size:11px;color:${CLR.muted};font-weight:700;letter-spacing:.5px;margin-bottom:4px;font-family:${FONT}">${L.diasDestacados}</div>` +
    rows(
      (k.best_day ? `<tr><td style="padding:8px 0;font-size:13px;color:#111827;font-weight:600;font-family:${FONT}"><span style="color:${CLR.green}">▲</span> ${L.mejor}: ${esc(dayLabel(k.best_day, lang))}</td><td style="padding:8px 0;text-align:right;font-size:13px;color:#111827;font-family:${FONT}">${esc(fmtMxn(k.best_day.revenue))} · ${k.best_day.bookings} ${L.res}</td></tr>` : '') +
      (k.worst_day ? `<tr><td style="padding:8px 0;border-top:1px solid #f1f3f5;font-size:13px;color:#111827;font-weight:600;font-family:${FONT}"><span style="color:#dc2626">▼</span> ${L.masFloja}: ${esc(dayLabel(k.worst_day, lang))}</td><td style="padding:8px 0;border-top:1px solid #f1f3f5;text-align:right;font-size:13px;color:#111827;font-family:${FONT}">${esc(fmtMxn(k.worst_day.revenue))} · ${k.worst_day.bookings} ${L.res}</td></tr>` : '')
    )
  ) : '';

  const top = (k.top_customers && k.top_customers.length > 0) ? card(
    `<div style="font-size:11px;color:${CLR.muted};font-weight:700;letter-spacing:.5px;margin-bottom:4px;font-family:${FONT}">${L.topJugadores}</div>` +
    rows(k.top_customers.map((c, i) =>
      threeColRow(`${i + 1}. ${esc(c.name)}`, `${c.bookings} ${L.res}`, esc(fmtMxn(c.revenue)), i === 0, CLR.green)
    ).join(''))
  ) : '';

  const vips = (k.inactive_vips && k.inactive_vips.length > 0) ? card(
    `<div style="font-size:11px;color:#92400e;font-weight:700;letter-spacing:.5px;margin-bottom:4px;font-family:${FONT}">${L.vipsSinVenir}</div>` +
    rows(k.inactive_vips.slice(0, 3).map((v, i) =>
      threeColRow(esc(v.name), `${esc(fmtMxn(v.rev_12mo))} LTV`, `${v.days_inactive} ${L.dias}`, i === 0, '#dc2626')
    ).join('')),
    '#fcd34d'
  ) : '';

  return shell(
    hero('chart', L.resumenSemanal, courseName) +
    pill +
    grid1 +
    grid2 +
    comparativa +
    bw +
    top +
    vips +
    btn(L.abrirDash, APP),
    L.pre(courseName)
  );
}

// v20.16: envía email del insight si pref habilitada (v6: numbers-first, recibe KPIs; v7: lang)
async function sendInsightEmail(
  sb: any,
  courseId: string,
  courseName: string,
  kpis: Kpis,
  weekStart: string,
  lang: Lang
): Promise<{ sent: boolean; reason?: string; recipient?: string }> {
  if (!RESEND_API_KEY) return { sent: false, reason: 'no_resend_key' };

  // Obtener course_admin
  const { data: admin } = await sb.from('user_profiles')
    .select('id, email, full_name')
    .eq('managed_course_id', courseId)
    .eq('user_role', 'course_admin')
    .limit(1)
    .maybeSingle();

  if (!admin?.email) return { sent: false, reason: 'no_admin_email' };

  // Check pref weekly_insight_email_enabled
  const { data: prefCheck } = await sb.rpc('is_admin_notif_enabled_internal', {
    p_user_id: admin.id,
    p_course_id: courseId,
    p_kind: 'weekly_insight_email'
  });

  if (prefCheck === false) return { sent: false, reason: 'pref_disabled' };

  const html = renderInsightEmail(courseName, kpis, lang);
  const subject = EMAIL_L[lang].subj(courseName, weekStart);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [admin.email], subject, html })
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('[weekly-insight email] Resend err:', errBody);
      return { sent: false, reason: 'resend_failed', recipient: admin.email };
    }
    return { sent: true, recipient: admin.email };
  } catch (e) {
    console.error('[weekly-insight email] fetch err:', e);
    return { sent: false, reason: 'fetch_error', recipient: admin.email };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const courseId = body?.course_id;
    const weekStart = body?.week_start || null;
    const force = body?.force === true;
    const skipEmail = body?.skip_email === true;
    // v7: idioma del insight. Explicito en el body > preferencia del campo (cron) > espanol.
    let lang: Lang = body?.lang === "en" ? "en" : (body?.lang === "es" ? "es" : null as any);

    if (!courseId) {
      return new Response(JSON.stringify({ error: "missing course_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const cronHeader = req.headers.get("x-partee-cron-secret");
    const isCronCall = CRON_SECRET && cronHeader === CRON_SECRET;
    let callerUserId: string | null = null;

    const supabase = createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } });

    if (!isCronCall) {
      const authHeader = req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const token = authHeader.substring(7);
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      callerUserId = userData.user.id;
      const { data: profile } = await supabase.from("user_profiles").select("user_role,managed_course_id").eq("id", callerUserId).single();
      if (!profile || (profile.user_role !== "platform_admin" && !(profile.user_role === "course_admin" && profile.managed_course_id === courseId))) {
        return new Response(JSON.stringify({ error: "unauthorized: not admin of this course" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // v7: sin lang explicito (tipicamente el cron), intentar preferencia del campo.
    // Si la columna preferred_lang no existe, el select devuelve error y seguimos en espanol.
    if (!lang) {
      lang = "es";
      try {
        const { data: cpref, error: cprefErr } = await supabase.from("courses").select("preferred_lang").eq("id", courseId).maybeSingle();
        if (!cprefErr && cpref?.preferred_lang === "en") lang = "en";
      } catch (_e) { /* columna inexistente u otro error: espanol */ }
    }

    const computedWeekStart = weekStart
      ? new Date(weekStart + "T00:00:00Z")
      : (() => {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - 7);
          const dow = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() - (dow - 1));
          d.setUTCHours(0, 0, 0, 0);
          return d;
        })();
    const computedWeekEnd = new Date(computedWeekStart);
    computedWeekEnd.setUTCDate(computedWeekEnd.getUTCDate() + 6);
    const weekStartStr = computedWeekStart.toISOString().slice(0, 10);
    const weekEndStr = computedWeekEnd.toISOString().slice(0, 10);

    if (!force) {
      const { data: existing } = await supabase
        .from("admin_weekly_insights")
        .select("id, insight_md, source, week_start, week_end, generated_at, kpi_snapshot")
        .eq("course_id", courseId)
        .eq("week_start", weekStartStr)
        .maybeSingle();
      if (existing) {
        return new Response(JSON.stringify({ success: true, insight: existing, cached: true, email_sent: false, already_existed: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    const { data: kpis, error: kpiErr } = await supabase.rpc("get_weekly_insight_kpis", {
      p_course_id: courseId,
      p_week_start: weekStartStr
    });
    if (kpiErr) throw new Error("kpi rpc err: " + kpiErr.message);
    if (!kpis) throw new Error("kpi rpc returned null");

    let insightMd = "";
    let source = "template";
    let fallbackReason: string | null = null;
    if (ANTHROPIC_API_KEY) {
      try {
        insightMd = await generateClaudeInsight(kpis as Kpis, lang);
        source = "claude";
      } catch (e) {
        fallbackReason = String(e);
        console.warn("[v20.7] Claude failed, falling back to template:", String(e));
        insightMd = generateTemplateInsight(kpis as Kpis, lang);
        source = "template";
      }
    } else {
      fallbackReason = "no_api_key";
      insightMd = generateTemplateInsight(kpis as Kpis, lang);
      source = "template";
    }

    if (force) await supabase.from("admin_weekly_insights").delete().eq("course_id", courseId).eq("week_start", weekStartStr);
    const { data: saved, error: saveErr } = await supabase
      .from("admin_weekly_insights")
      .insert({ course_id: courseId, week_start: weekStartStr, week_end: weekEndStr, insight_md: insightMd, source, kpi_snapshot: { ...(kpis as Kpis), _lang: lang }, generated_by: callerUserId })
      .select()
      .single();
    if (saveErr) throw new Error("save err: " + saveErr.message);

    // v20.16 + v21.43: email send numbers-first (si no skip + Resend disponible + pref on)
    let emailResult = null;
    if (!skipEmail) {
      const kpisTyped = kpis as Kpis;
      emailResult = await sendInsightEmail(supabase, courseId, kpisTyped.course_name, kpisTyped, weekStartStr, lang);
    }

    return new Response(JSON.stringify({
      success: true,
      insight: saved,
      cached: false,
      source,
      lang,
      has_anthropic_key: !!ANTHROPIC_API_KEY,
      fallback_reason: fallbackReason,
      week_start: weekStartStr,
      already_existed: false,
      email: emailResult
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[v20.7/v20.16] error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
