// athlete.coach — Strava OAuth Proxy
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── 1. Token tauschen (Authorization Code → Access + Refresh Token) ──
  if (action === 'exchange') {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'code fehlt' });
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json(data);
  }

  // ── 2. Token erneuern ──
  if (action === 'refresh') {
    const { refresh_token } = req.query;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token fehlt' });
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json(data);
  }

  // ── 3. Aktivitäten abrufen (mit auto-refresh) ──
  if (action === 'activities') {
    let { access_token, refresh_token, expires_at, page = 1, per_page = 100 } = req.query;
    expires_at = parseInt(expires_at) || 0;
    if (Date.now() / 1000 > expires_at - 60) {
      if (!refresh_token) return res.status(401).json({ error: 'Token abgelaufen, refresh_token fehlt' });
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const refreshed = await r.json();
      if (!r.ok) return res.status(401).json({ error: 'Refresh fehlgeschlagen', detail: refreshed });
      access_token = refreshed.access_token;
      res.setHeader('X-New-Access-Token', refreshed.access_token);
      res.setHeader('X-New-Expires-At', String(refreshed.expires_at));
    }
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${per_page}&page=${page}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json(data);
  }

  // ── 4. Webhook registrieren ──
  if (action === 'webhook_register') {
    const { callback_url, verify_token } = req.query;
    const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        callback_url,
        verify_token,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json(data);
  }

  // ── 5. Webhook Status ──
  if (action === 'webhook_status') {
    const r = await fetch(
      `https://www.strava.com/api/v3/push_subscriptions?client_id=${process.env.STRAVA_CLIENT_ID}&client_secret=${process.env.STRAVA_CLIENT_SECRET}`
    );
    return res.status(200).json(await r.json());
  }

  // ── 6. Webhook löschen ──
  if (action === 'webhook_delete') {
    const r = await fetch(`https://www.strava.com/api/v3/push_subscriptions/${req.query.subscription_id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
      }),
    });
    return res.status(200).json(r.status === 204 ? { ok: true } : await r.json());
  }

  return res.status(400).json({ error: 'Unbekannte action: ' + action });
}
