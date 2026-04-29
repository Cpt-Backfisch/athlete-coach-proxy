export default async function handler(req, res) {
  // GET: Strava Webhook-Validierung
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && challenge) {
      return res.status(200).json({ "hub.challenge": challenge });
    }
    return res.status(200).json({ ok: true });
  }

  // POST: Neue Aktivität
  if (req.method === "POST") {
    const event = req.body;
    console.log('[webhook] received body:', JSON.stringify(event));

    console.log('[webhook] object_type check:', event.object_type, '| aspect_type check:', event.aspect_type);
    if (event.object_type !== "activity" || event.aspect_type !== "create") {
      console.log('[webhook] EARLY RETURN: not an activity create event');
      return res.status(200).json({ ok: true });
    }

    // Sofort 200 antworten damit Strava nicht retried
    res.status(200).json({ ok: true });
    console.log('[webhook] 200 sent to Strava, continuing async work');

    // Deduplication via Supabase
    const dedupKey = `webhook_processed_${event.object_id}`;
    const SUPABASE_URL = "https://cpzdqgrqodvwtnqmusso.supabase.co";
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    try {
      console.log('[webhook] fetching settings from supabase, dedupKey:', dedupKey);
      const chk = await fetch(
        `${SUPABASE_URL}/rest/v1/settings?select=data,user_id&limit=1`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        },
      );
      const rows = await chk.json();
      console.log('[webhook] settings fetch status:', chk.status, '| rows count:', rows?.length);
      const cfg = JSON.parse(rows?.[0]?.data || "{}");
      const lastProcessed = cfg[dedupKey] || 0;
      console.log('[webhook] dedup check: lastProcessed=', lastProcessed, '| age_ms=', Date.now() - lastProcessed);
      if (Date.now() - lastProcessed < 10 * 60 * 1000) {
        console.log('[webhook] EARLY RETURN: duplicate, already processed within 10min');
        return; // Duplicate — already processed
      }
      // Mark as processed immediately before async work
      cfg[dedupKey] = Date.now();
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/settings?user_id=eq.${rows?.[0]?.user_id || ""}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ data: JSON.stringify(cfg) }),
        },
      );
      console.log('[webhook] dedup PATCH status:', patchRes.status, '| user_id:', rows?.[0]?.user_id);

      // Telegram-Push deaktiviert? Dann abbrechen.
      console.log('[webhook] telegram_push_enabled:', cfg.telegram_push_enabled);
      if (cfg.telegram_push_enabled === "false") {
        console.log('[webhook] EARLY RETURN: telegram_push_enabled=false');
        return;
      }

      // coach_system_prompt (React App) hat Vorrang vor coachPrompt (Monolith)
      let coachPrompt =
        "Du bist Sebastians persönlicher Triathlon-Coach. Bewerte diese Einheit in 2-3 kurzen, motivierenden Sätzen auf Deutsch. Konkret, persönlich, direkt.";
      if (cfg.coach_system_prompt) coachPrompt = cfg.coach_system_prompt;
      else if (cfg.coachPrompt) coachPrompt = cfg.coachPrompt;
      console.log('[webhook] coach prompt loaded: length=', coachPrompt.length);

      // Strava Access Token holen
      console.log('[webhook] fetching strava access token');
      const tr = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token: process.env.STRAVA_ATHLETE_REFRESH_TOKEN,
          grant_type: "refresh_token",
        }),
      });
      const trJson = await tr.json();
      const { access_token } = trJson;
      console.log('[webhook] strava token fetch status:', tr.status, '| access_token present:', !!access_token);

      // Aktivität laden
      console.log('[webhook] fetching activity from strava, id:', event.object_id);
      const ar = await fetch(
        `https://www.strava.com/api/v3/activities/${event.object_id}`,
        {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      );
      const act = await ar.json();
      console.log('[webhook] activity fetch status:', ar.status, '| activity:', act ? `type=${act.type} name="${act.name}"` : 'NOT FOUND');

      const types = {
        Run: "Laufen",
        Ride: "Radfahren",
        Swim: "Schwimmen",
        VirtualRide: "Radfahren (Indoor)",
        Walk: "Gehen",
        OpenWaterSwimming: "Freiwasserschwimmen",
      };
      const type = types[act.type] || act.type;
      const distKm = act.distance ? (act.distance / 1000).toFixed(1) : null;
      const durMin = act.moving_time ? Math.round(act.moving_time / 60) : null;
      const hr = act.average_heartrate
        ? Math.round(act.average_heartrate)
        : null;
      const pace =
        act.average_speed && act.type === "Run"
          ? `${Math.floor(1000 / act.average_speed / 60)}:${String(Math.round((1000 / act.average_speed) % 60)).padStart(2, "0")} /km`
          : null;

      const details = [
        distKm ? `Distanz: ${distKm} km` : null,
        durMin ? `Dauer: ${durMin} min` : null,
        hr ? `Ø Herzfrequenz: ${hr} bpm` : null,
        pace ? `Pace: ${pace}` : null,
        act.total_elevation_gain
          ? `Höhenmeter: ${Math.round(act.total_elevation_gain)} m`
          : null,
        act.description ? `Notizen: ${act.description}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const prompt = `Einheit: ${type} — ${act.name}\n${details}`;

      // Claude aufrufen
      console.log('[webhook] calling claude haiku');
      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          system: coachPrompt,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const crJson = await cr.json();
      console.log('[webhook] claude response status:', cr.status, '| stop_reason:', crJson.stop_reason, '| content present:', !!crJson.content?.[0]?.text);
      let coachMsg = crJson.content?.[0]?.text || "Super Training! 💪";
      // Bei max_tokens: am letzten vollständigen Satz abschneiden
      if (crJson.stop_reason === "max_tokens") {
        const lastStop = Math.max(
          coachMsg.lastIndexOf("."),
          coachMsg.lastIndexOf("!"),
          coachMsg.lastIndexOf("?"),
        );
        if (lastStop > 0) coachMsg = coachMsg.slice(0, lastStop + 1);
      }

      // Telegram senden
      const stats = [
        type,
        distKm ? `${distKm} km` : null,
        durMin ? `${durMin} min` : null,
        hr ? `♥ ${hr}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      console.log('[webhook] sending telegram message');
      const tgRes = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `🏅 *${act.name}*\n${stats}\n\n${coachMsg}`,
            parse_mode: "Markdown",
          }),
        },
      );
      console.log('[webhook] telegram send result status:', tgRes.status);
    } catch (e) {
      console.error('[webhook] CAUGHT ERROR:', e);
    }

    return;
  }

  return res.status(405).end();
}
