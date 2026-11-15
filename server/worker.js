// Малый шаг — серверная часть (Cloudflare Worker + D1)
// Маршруты:
//   POST /tg            — вебхук Telegram (команды бота)
//   POST /api/sync      — приложение сообщает, что сделано сегодня
//   POST /api/settings  — настройки напоминаний
//   POST /api/me        — получить настройки
//   cron каждые 15 минут — напоминания

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
const MAX_SENDS_PER_RUN = 40; // лимит подзапросов бесплатного плана — 50

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/tg' && req.method === 'POST') return await onTelegram(req, env);
      if (url.pathname.startsWith('/api/') && req.method === 'POST') return await onApi(url.pathname, req, env);
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'maliyshag' });
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      console.error('fetch error', e && e.stack || e);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, Date.now()).catch(e => console.error('cron error', e && e.stack || e)));
  }
};

/* ---------------- crypto helpers ---------------- */
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, typeof msg === 'string' ? enc.encode(msg) : msg);
}
async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
export async function webhookSecret(token) { return (await sha256hex('maliyshag:' + token)).slice(0, 48); }

// Проверка подписи initData из Telegram Mini App
export async function verifyInitData(initData, token, maxAgeSec = 7 * 86400, nowSec = Math.floor(Date.now() / 1000)) {
  if (!initData || typeof initData !== 'string' || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const secret = await hmac(enc.encode('WebAppData'), token);
  const build = (skipSignature) => [...params.entries()]
    .filter(([k]) => k !== 'hash' && !(skipSignature && k === 'signature'))
    .map(([k, v]) => k + '=' + v).sort().join('\n');
  let ok = hex(await hmac(secret, build(false))) === hash;
  if (!ok && params.has('signature')) ok = hex(await hmac(secret, build(true))) === hash;
  if (!ok) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || nowSec - authDate > maxAgeSec) return null;
  let user = null; try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  if (!user || !user.id) return null;
  return user;
}

/* ---------------- time helpers ---------------- */
function validTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return null; }
}
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}`, y: +p.year, m: +p.month, d: +p.day };
}
const dayDiff = (a, b) => Math.round((Date.UTC(...a.split('-').map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...b.split('-').map((x, i) => i === 1 ? x - 1 : +x))) / 86400000);
const hmAdd = (hm, min) => { const [h, m] = hm.split(':').map(Number); const t = Math.min(23 * 60 + 59, h * 60 + m + min); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

/* ---------------- Asr time (алгоритм praytimes) ---------------- */
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const fix = (a, b) => { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; };
function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360);
  const q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)), 360);
  const e = 23.439 - 0.00000036 * D;
  const RA = deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15;
  const eqt = q / 15 - fix(RA, 24);
  const decl = deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L))));
  return { decl, eqt };
}
// Возвращает момент асра (ms, UTC) для даты y-m-d в точке lat/lon. factor: 1 — стандартный, 2 — ханафитский
export function asrInstant(y, m, d, lat, lon, factor = 1) {
  const jd0 = Date.UTC(y, m - 1, d) / 86400000 + 2440587.5; // юлианская дата на 00:00 UTC
  let t = 15; // начальное приближение (часы, UTC-сдвиг ниже)
  let asrUtc = NaN;
  for (let i = 0; i < 2; i++) {
    const jd = jd0 + (t - lon / 15) / 24 - 0; // приблизительный момент
    const { decl, eqt } = sunPosition(jd);
    const noon = 12 - eqt - lon / 15; // полдень в часах UTC
    const angle = -deg(Math.atan(1 / (factor + Math.tan(rad(Math.abs(lat - decl))))));
    const cosT = (-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(lat))) / (Math.cos(rad(decl)) * Math.cos(rad(lat)));
    if (cosT < -1 || cosT > 1) return null;
    asrUtc = noon + deg(Math.acos(cosT)) / 15;
    t = asrUtc + lon / 15;
  }
  return Date.UTC(y, m - 1, d) + asrUtc * 3600000;
}
export function asrLocalHM(y, m, d, lat, lon, factor, tz) {
  const ms = asrInstant(y, m, d, lat, lon, factor);
  if (ms == null) return null;
  return localParts(ms, tz).hm;
}

/* ---------------- Telegram ---------------- */
async function tgCall(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    let data = null; try { data = await r.json(); } catch (e) {}
    if (!r.ok) console.warn('telegram', method, r.status, data && data.description);
    return { status: r.status, data };
  } catch (e) {
    console.error('telegram fetch failed', method, String(e));
    return { status: 0, data: null };
  }
}
const appButton = (env, text = 'Открыть «Малый шаг»') => ({ inline_keyboard: [[{ text, web_app: { url: env.APP_URL } }]] });
const escHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function onTelegram(req, env) {
  const secret = await webhookSecret(env.BOT_TOKEN);
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return json({ ok: false }, 403);
  const upd = await req.json();
  const now = Date.now();

  if (upd.my_chat_member) {
    const m = upd.my_chat_member, st = m.new_chat_member && m.new_chat_member.status;
    if (m.chat && m.chat.type === 'private') {
      await env.DB.prepare('UPDATE users SET blocked=? WHERE id=?').bind(st === 'kicked' ? 1 : 0, m.chat.id).run();
    }
    return json({ ok: true });
  }
  const msg = upd.message;
  if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return json({ ok: true });
  const from = msg.from, text = (msg.text || '').trim(), cmd = text.split(/[\s@]/)[0].toLowerCase();

  await env.DB.prepare(`INSERT INTO users (id, first_name, username, lang, created_at, blocked) VALUES (?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, lang=excluded.lang, blocked=0`)
    .bind(from.id, (from.first_name || '').slice(0, 64), (from.username || '').slice(0, 64), (from.language_code || '').slice(0, 8), now).run();

  let reply;
  if (cmd === '/start') {
    reply = { text: `Ас-саляму алейкум, ${escHtml(from.first_name || 'друг')}! 🤍\n\n<b>Малый шаг</b> — трекер привычек. Отмечай каждый день то, что сделал, и не разрывай цепочку.\n\nВ приложении можно включить напоминание после асра: бот напишет, если что-то осталось несделанным.`, reply_markup: appButton(env) };
  } else if (cmd === '/stop') {
    await env.DB.prepare("UPDATE users SET mode='off' WHERE id=?").bind(from.id).run();
    reply = { text: 'Напоминания выключены. Включить снова: /on или в настройках приложения.' };
  } else if (cmd === '/on') {
    await env.DB.prepare("UPDATE users SET mode=CASE WHEN mode='off' OR mode IS NULL THEN 'asr' ELSE mode END WHERE id=?").bind(from.id).run();
    reply = { text: 'Напоминания включены 🔔 Время и город можно выбрать в приложении.', reply_markup: appButton(env, 'Настроить') };
  } else if (cmd === '/admin') {
    const cur = await env.DB.prepare("SELECT v FROM meta WHERE k='admin'").first();
    if (!cur) { await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('admin', ?)").bind(String(from.id)).run(); reply = { text: 'Ты назначен администратором. Статистика: /stats' }; }
    else reply = { text: cur.v === String(from.id) ? 'Ты уже администратор. Статистика: /stats' : 'Администратор уже назначен.' };
  } else if (cmd === '/stats') {
    const cur = await env.DB.prepare("SELECT v FROM meta WHERE k='admin'").first();
    if (!cur || cur.v !== String(from.id)) reply = { text: 'Команда доступна только администратору.' };
    else {
      const q = s => env.DB.prepare(s).bind(now).first();
      const all = await env.DB.prepare('SELECT COUNT(*) n FROM users').first();
      const d1 = await q('SELECT COUNT(*) n FROM users WHERE last_seen > ? - 86400000');
      const d7 = await q('SELECT COUNT(*) n FROM users WHERE last_seen > ? - 7*86400000');
      const d30 = await q('SELECT COUNT(*) n FROM users WHERE last_seen > ? - 30*86400000');
      const rem = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE mode!='off' AND blocked=0 AND tz IS NOT NULL").first();
      const blk = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE blocked=1').first();
      const fresh = await q('SELECT COUNT(*) n FROM users WHERE created_at > ? - 7*86400000');
      reply = { text: `📊 <b>Малый шаг — статистика</b>\n\nВсего пользователей: <b>${all.n}</b>\nНовых за 7 дней: ${fresh.n}\n\nОткрывали приложение:\n• за сутки: ${d1.n}\n• за 7 дней: ${d7.n}\n• за 30 дней: ${d30.n}\n\nНапоминания включены: ${rem.n}\nЗаблокировали бота: ${blk.n}` };
    }
  } else {
    reply = { text: 'Нажми кнопку ниже, чтобы открыть трекер.\n\nКоманды: /on — включить напоминания, /stop — выключить.', reply_markup: appButton(env) };
  }
  await tgCall(env, 'sendMessage', { chat_id: from.id, parse_mode: 'HTML', ...reply });
  return json({ ok: true });
}

/* ---------------- API для приложения ---------------- */
const cleanList = a => Array.isArray(a) ? a.slice(0, 40).map(x => String(x).slice(0, 80)) : [];
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function onApi(path, req, env) {
  let body; try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  const now = Date.now(), tz = validTz(body.tz);
  const canWrite = user.allows_write_to_pm === true;

  // базовая запись пользователя
  await env.DB.prepare(`INSERT INTO users (id, first_name, username, lang, tz, created_at, last_seen) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, lang=excluded.lang,
      tz=COALESCE(excluded.tz, users.tz), last_seen=excluded.last_seen`)
    .bind(user.id, (user.first_name || '').slice(0, 64), (user.username || '').slice(0, 64), (user.language_code || '').slice(0, 8), tz, now, now).run();
  if (canWrite) await env.DB.prepare('UPDATE users SET blocked=0 WHERE id=?').bind(user.id).run();

  if (path === '/api/sync') {
    if (!isDay(body.day)) return json({ ok: false, error: 'bad_day' }, 400);
    const done = Math.max(0, Math.min(99, body.done | 0)), total = Math.max(0, Math.min(99, body.total | 0));
    await env.DB.prepare('UPDATE users SET habits=?, last_seen_day=? WHERE id=?').bind(JSON.stringify(cleanList(body.habits)), body.day, user.id).run();
    await env.DB.prepare(`INSERT INTO days (user_id, day, done, total, pending, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id, day) DO UPDATE SET done=excluded.done, total=excluded.total, pending=excluded.pending, updated_at=excluded.updated_at`)
      .bind(user.id, body.day, done, total, JSON.stringify(cleanList(body.pending)), now).run();
    // чистим старые дни (храним 60 дней)
    if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM days WHERE updated_at < ?").bind(now - 60 * 86400000).run();
    return json({ ok: true });
  }

  if (path === '/api/settings') {
    const mode = ['asr', 'time', 'off'].includes(body.mode) ? body.mode : 'asr';
    const rtime = /^([01]\d|2[0-3]):[0-5]\d$/.test(body.rtime || '') ? body.rtime : '18:00';
    const lat = Number.isFinite(body.lat) && Math.abs(body.lat) <= 66 ? body.lat : null;
    const lon = Number.isFinite(body.lon) && Math.abs(body.lon) <= 180 ? body.lon : null;
    const city = String(body.city || '').slice(0, 64) || null;
    const factor = body.asr_factor === 2 ? 2 : 1;
    const address = ['brother', 'sister', 'name'].includes(body.address) ? body.address : 'name';
    await env.DB.prepare('UPDATE users SET mode=?, rtime=?, lat=?, lon=?, city=?, asr_factor=?, address=?, settings_set=1 WHERE id=?')
      .bind(mode, rtime, lat, lon, city, factor, address, user.id).run();
    return json({ ok: true, ...(await settingsOut(env, user.id, now)) });
  }

  if (path === '/api/me') return json({ ok: true, ...(await settingsOut(env, user.id, now)) });
  return json({ ok: false, error: 'not_found' }, 404);
}

async function settingsOut(env, id, now) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  if (!u) return {};
  let asr = null, remindAt = null;
  if (u.tz) {
    const lp = localParts(now, u.tz);
    if (u.lat != null && u.lon != null) asr = asrLocalHM(lp.y, lp.m, lp.d, u.lat, u.lon, u.asr_factor || 1, u.tz);
    remindAt = targetHM(u, lp);
  }
  return { settings: { mode: u.mode, rtime: u.rtime, lat: u.lat, lon: u.lon, city: u.city, asr_factor: u.asr_factor, address: u.address, set: !!u.settings_set }, asr, remindAt, blocked: !!u.blocked };
}

/* ---------------- Напоминания ---------------- */
const ASR_DELAY_MIN = 20;
function targetHM(u, lp) {
  if (u.mode === 'off') return null;
  if (u.mode === 'time') return u.rtime || '18:00';
  if (u.lat != null && u.lon != null) {
    const a = asrLocalHM(lp.y, lp.m, lp.d, u.lat, u.lon, u.asr_factor || 1, u.tz);
    if (a) return hmAdd(a, ASR_DELAY_MIN);
  }
  return '17:00';
}
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return (m10 === 1 && m100 !== 11) ? a : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) ? b : c; };
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function addr(u, cap) {
  const w = u.address === 'brother' ? 'брат' : u.address === 'sister' ? 'сестра' : escHtml(u.first_name || 'друг');
  return cap ? w[0].toUpperCase() + w.slice(1) : w;
}
const fmtList = items => items.slice(0, 6).map(x => '• ' + escHtml(x)).join('\n') + (items.length > 6 ? `\n• и ещё ${items.length - 6}` : '');

export function composeMessage(u, kind, row) {
  const a = addr(u), A = addr(u, true);
  if (kind === 'nudge') return pick([
    `${A}, давно не виделись 🤍\n\nПерерывы бывают у всех, главное — вернуться. Начни снова с одного малого шага, прямо сегодня.`,
    `Ас-саляму алейкум, ${a}.\n\nСамые любимые Аллаху дела — постоянные, даже если малые. Отметь сегодня хотя бы одну привычку, и цепочка начнётся заново.`,
    `${A}, мы скучаем по твоим отметкам 🌿\n\nНе нужно наверстывать всё. Один шаг сегодня уже меняет день.`
  ]);
  if (kind === 'absent') return pick([
    `Ас-саляму алейкум, ${a}! 🤍\n\nСегодня в «Малом шаге» ещё нет ни одной отметки. День не закончился: загляни на минуту и отметь, что уже сделано.`,
    `${A}, как проходит день? 🌿\n\nОткрой трекер и отметь, что получилось. Даже один малый шаг считается.`,
    `${A}, аср уже наступил, а цепочка ждёт сегодняшней отметки. Пара минут, и день засчитан 🔥`
  ]);
  const pending = row && row.pendingList || [];
  const n = pending.length, list = fmtList(pending);
  const head = row && row.done > 0
    ? pick([`${A}, ты уже сделал(а) ${row.done} из ${row.total} 💪 Осталось совсем немного:`, `Хороший день, ${a}! Закроем его полностью? Осталось:`])
    : pick([`Ас-саляму алейкум, ${a}! День ещё не закончился, и всё можно успеть:`, `${A}, маленькое напоминание 🌿 На сегодня осталось:`]);
  const tail = pick([
    'Не обязательно всё сразу. Начни с одного 🤍',
    'Пара минут, и цепочка не прервётся 🔥',
    'Самые любимые Аллаху дела — постоянные, даже если малые.',
    'Ты справишься. Один малый шаг, и ещё один 🤍'
  ]);
  return `${head}\n\n${list}\n\n${tail}`;
}

export async function runReminders(env, now) {
  const { results } = await env.DB.prepare("SELECT * FROM users WHERE mode != 'off' AND blocked = 0 AND tz IS NOT NULL").all();
  let sends = 0;
  for (const u of results || []) {
    if (sends >= MAX_SENDS_PER_RUN) break;
    const tz = validTz(u.tz); if (!tz) continue;
    const lp = localParts(now, tz);
    if (u.reminded_day === lp.day) continue;
    if (lp.hm >= '23:00' || lp.hm < '05:00') continue;
    const target = targetHM(u, lp);
    if (!target || lp.hm < target) continue;

    const absent = u.last_seen_day ? dayDiff(lp.day, u.last_seen_day) : 999;
    let kind = null, row = null;
    if (absent >= 3) {
      if (absent > 21 || (u.nudged_at && now - u.nudged_at < 3 * 86400000)) { await markReminded(env, u.id, lp.day); continue; }
      kind = 'nudge';
    } else {
      row = await env.DB.prepare('SELECT * FROM days WHERE user_id=? AND day=?').bind(u.id, lp.day).first();
      if (row) {
        if (!row.total || row.done >= row.total) { await markReminded(env, u.id, lp.day); continue; }
        try { row.pendingList = JSON.parse(row.pending || '[]'); } catch (e) { row.pendingList = []; }
        kind = row.pendingList.length ? 'pending' : 'absent';
      } else {
        let habits = []; try { habits = JSON.parse(u.habits || '[]'); } catch (e) {}
        if (!habits.length && !u.settings_set) { await markReminded(env, u.id, lp.day); continue; }
        kind = 'absent';
      }
    }
    const text = composeMessage(u, kind, row);
    const r = await tgCall(env, 'sendMessage', { chat_id: u.id, text, parse_mode: 'HTML', reply_markup: appButton(env, 'Отметить привычки') });
    sends++;
    if (r.status === 403) await env.DB.prepare('UPDATE users SET blocked=1 WHERE id=?').bind(u.id).run();
    if (r.status === 429 || r.status === 0) break; // сеть или лимит Telegram — повторим в следующий запуск
    await env.DB.prepare(`UPDATE users SET reminded_day=?${kind === 'nudge' ? ', nudged_at=?' : ''} WHERE id=?`)
      .bind(...(kind === 'nudge' ? [lp.day, now, u.id] : [lp.day, u.id])).run();
  }
  return sends;
}
async function markReminded(env, id, day) { await env.DB.prepare('UPDATE users SET reminded_day=? WHERE id=?').bind(day, id).run(); }
