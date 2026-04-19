// Zentraler Chat-Endpunkt: Claude-Chat vom Frontend + Telegram-Test/Status
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action;

  // ── Telegram-Status prüfen ─────────────────────────────────────────────
  if (action === 'telegram_status') {
    const configured = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
    return res.status(200).json({ configured });
  }

  // ── Telegram-Test-Nachricht ────────────────────────────────────────────
  if (action === 'telegram_test') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return res.status(500).json({ error: 'Telegram nicht konfiguriert' });
    }
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ athlete.coach Verbindungstest erfolgreich!',
      }),
    });
    return res.status(r.ok ? 200 : 500).json(await r.json());
  }

  // ── Claude-Chat vom Frontend ───────────────────────────────────────────
  if (req.method === 'POST') {
    const { messages, systemPrompt, context } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages fehlt' });

    const fullSystem = [
      systemPrompt || '',
      context ? `\n\nTrainingsdaten:\n${context}` : '',
    ].join('');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: fullSystem,
        messages,
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json({ content: data.content[0].text });
  }

  return res.status(400).json({ error: 'Unbekannte Anfrage' });
}
