// Bidirektionaler Telegram-Coach: eingehende Nachrichten → Claude Sonnet → Telegram-Antwort
const SUPABASE_URL = 'https://cpzdqgrqodvwtnqmusso.supabase.co';

export default async function handler(req, res) {
  // Telegram sendet nur POST-Requests
  if (req.method !== 'POST') return res.status(405).end();

  // ── Webhook-Secret verifizieren ────────────────────────────────────────
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const update = req.body;
  const message = update?.message;
  if (!message?.text) return res.status(200).json({ ok: true }); // Kein Text → ignorieren

  // Sofort 200 antworten, damit Telegram nicht retried
  res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const userText = message.text;

  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    // ── Aktivitäten der letzten 8 Wochen laden ─────────────────────────
    const actsVor8W = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const actsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/activities?select=*&date=gte.${actsVor8W}&order=date.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const activities = await actsRes.json();

    // ── Nächste Wettkämpfe laden ────────────────────────────────────────
    const heute = new Date().toISOString().slice(0, 10);
    const racesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/races?select=*&date=gte.${heute}&order=date.asc&limit=3`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const races = await racesRes.json();

    // ── Settings laden (system_prompt + athlete_name) ───────────────────
    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=data&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const settingsRows = await settingsRes.json();
    const cfg = JSON.parse(settingsRows?.[0]?.data || '{}');
    const systemPrompt =
      cfg.coach_system_prompt ||
      'Du bist ein erfahrener Ausdauer-Coach. Analysiere die Trainingsdaten des Athleten und gib konkrete, motivierende Empfehlungen. Antworte auf Deutsch. Sei präzise und direkt — keine langen Einleitungen.';
    const athleteName = cfg.athlete_name || 'Athlet';

    // ── Kontext aufbauen ───────────────────────────────────────────────
    const formatDur = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}:${String(m).padStart(2, '0')} h` : `${m} min`;
    };
    const sportLabel = { run: 'Laufen', bike: 'Rad', swim: 'Schwimmen', misc: 'Sonstiges' };

    const actLines = (Array.isArray(activities) ? activities : [])
      .slice(0, 30)
      .map((a) => {
        const sport = sportLabel[a.sport_type] || a.sport_type;
        const dist = a.distance ? (a.distance / 1000).toFixed(1) + ' km' : '';
        const dur = a.duration ? formatDur(a.duration) : '';
        const hr = a.avg_hr ? `HF ${Math.round(a.avg_hr)}` : '';
        return `• ${a.date} — ${sport} — ${a.name || ''}${dist ? ' — ' + dist : ''}${dur ? ' — ' + dur : ''}${hr ? ' — ' + hr : ''}`;
      })
      .join('\n');

    const raceLines = (Array.isArray(races) ? races : [])
      .map((r) => {
        const tage = Math.round((new Date(r.date) - new Date()) / 86400000);
        return `• ${r.date} — ${r.name}${r.goal ? ' — Ziel: ' + r.goal : ''} (in ${tage} Tagen)`;
      })
      .join('\n');

    const kontext = [
      `Athlet: ${athleteName}`,
      `Zeitraum: letzte 8 Wochen`,
      '',
      'Trainingsübersicht:',
      actLines || '(keine Aktivitäten)',
      '',
      'Nächste Wettkämpfe:',
      raceLines || '(keine)',
    ].join('\n');

    // ── Claude Sonnet aufrufen ─────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: `${systemPrompt}\n\nTrainingsdaten:\n${kontext}`,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    const claudeData = await claudeRes.json();
    const antwort = claudeData.content?.[0]?.text || 'Ich konnte leider keine Antwort generieren.';

    // ── Antwort via Telegram senden ────────────────────────────────────
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: antwort }),
    });
  } catch (e) {
    console.error('telegram-coach error:', e);
    // Fehlermeldung an Telegram senden (Best-effort)
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '⚠️ Fehler beim Verarbeiten deiner Nachricht. Bitte versuche es erneut.',
        }),
      }
    ).catch(() => {});
  }
}
