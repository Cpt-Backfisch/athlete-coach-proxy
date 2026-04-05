export default async function handler(req, res) {
  // GET: Strava Webhook-Validierung
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && challenge) {
      return res.status(200).json({ 'hub.challenge': challenge });
    }
    return res.status(200).json({ ok: true });
  }

  // POST: Neue Aktivität
  if (req.method === 'POST') {
    const event = req.body;
    if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
      return res.status(200).json({ ok: true });
    }

    try {
      // Strava Access Token holen
      const tr = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token: process.env.STRAVA_ATHLETE_REFRESH_TOKEN,
          grant_type: 'refresh_token',
        }),
      });
      const { access_token } = await tr.json();

      // Aktivität laden
      const ar = await fetch(`https://www.strava.com/api/v3/activities/${event.object_id}`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const act = await ar.json();

      const types = {
        Run: 'Laufen', Ride: 'Radfahren', Swim: 'Schwimmen',
        VirtualRide: 'Radfahren (Indoor)', Walk: 'Gehen',
        OpenWaterSwimming: 'Freiwasserschwimmen'
      };
      const type = types[act.type] || act.type;
      const distKm = act.distance ? (act.distance / 1000).toFixed(1) : null;
      const durMin = act.moving_time ? Math.round(act.moving_time / 60) : null;
      const hr = act.average_heartrate ? Math.round(act.average_heartrate) : null;
      const pace = (act.average_speed && act.type === 'Run')
        ? `${Math.floor(1000 / act.average_speed / 60)}:${String(Math.round((1000 / act.average_speed) % 60)).padStart(2, '0')} /km`
        : null;

      // Coach-Prompt aus Supabase lesen
      let coachPrompt = 'Du bist Sebastians persönlicher Triathlon-Coach. Bewerte diese Einheit in 2-3 kurzen, motivierenden Sätzen auf Deutsch. Konkret, persönlich, direkt.';
      try {
        const sbRes = await fetch('https://cpzdqgrqodvwtnqmusso.supabase.co/rest/v1/settings?select=data&limit=1', {
          headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
        });
        const sbRows = await sbRes.json();
        const sbCfg = JSON.parse(sbRows?.[0]?.data || '{}');
        if (sbCfg.coachPrompt) coachPrompt = sbCfg.coachPrompt;
      } catch (_) {}

      // Aktivitäts-Details für Prompt
      const details = [
        distKm ? `Distanz: ${distKm} km` : null,
        durMin ? `Dauer: ${durMin} min` : null,
        hr ? `Ø Herzfrequenz: ${hr} bpm` : null,
        pace ? `Pace: ${pace}` : null,
        act.total_elevation_gain ? `Höhenmeter: ${Math.round(act.total_elevation_gain)} m` : null,
        act.description ? `Notizen: ${act.description}` : null,
      ].filter(Boolean).join('\n');

      const prompt = `Einheit: ${type} — ${act.name}\n${details}`;

      // Claude aufrufen
      const claudeKey = process.env.CLAUDE_API_KEY;
      const cr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: coachPrompt,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const coachMsg = (await cr.json()).content?.[0]?.text || 'Super Training! 💪';

      // Telegram senden
      const stats = [type, distKm ? `${distKm} km` : null, durMin ? `${durMin} min` : null, hr ? `♥ ${hr}` : null]
        .filter(Boolean).join(' · ');

      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `🏅 *${act.name}*\n${stats}\n\n${coachMsg}`,
          parse_mode: 'Markdown'
        }),
      });

    } catch (e) {
      console.error('Webhook error:', e);
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
