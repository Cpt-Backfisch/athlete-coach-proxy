// Bidirektionaler Telegram-Coach: eingehende Nachrichten → Claude Sonnet → Telegram-Antwort
const SUPABASE_URL = "https://cpzdqgrqodvwtnqmusso.supabase.co";

export default async function handler(req, res) {
  // Telegram sendet nur POST-Requests
  if (req.method !== "POST") return res.status(405).end();

  // ── Webhook-Secret verifizieren ────────────────────────────────────────
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const update = req.body;
  const message = update?.message;
  if (!message?.text) return res.status(200).json({ ok: true }); // Kein Text → ignorieren

  const chatId = message.chat.id;
  const userText = message.text;

  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  try {
    // ── Alle drei Blobs parallel laden ────────────────────────────────────
    const [actsRes, racesRes, settingsRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/activities?select=data&limit=1`, {
        headers: sbHeaders,
      }),
      fetch(`${SUPABASE_URL}/rest/v1/races?select=data&limit=1`, {
        headers: sbHeaders,
      }),
      fetch(`${SUPABASE_URL}/rest/v1/settings?select=data&limit=1`, {
        headers: sbHeaders,
      }),
    ]);

    const [actsRows, racesRows, settingsRows] = await Promise.all([
      actsRes.json(),
      racesRes.json(),
      settingsRes.json(),
    ]);

    // ── Blobs parsen ───────────────────────────────────────────────────────
    const allActivities = JSON.parse(actsRows?.[0]?.data || "[]");
    const allRaces = JSON.parse(racesRows?.[0]?.data || "[]");
    const cfg = JSON.parse(settingsRows?.[0]?.data || "{}");

    // ── Settings auslesen ──────────────────────────────────────────────────
    // coach_system_prompt (React App) hat Vorrang vor coachPrompt (Monolith)
    const systemPrompt =
      cfg.coach_system_prompt ||
      cfg.coachPrompt ||
      "Du bist ein erfahrener Ausdauer-Coach. Analysiere die Trainingsdaten des Athleten und gib konkrete, motivierende Empfehlungen. Antworte auf Deutsch. Sei präzise und direkt — keine langen Einleitungen.";
    const athleteName = cfg.athlete_name || "Athlet";

    // ── Aktivitäten: letzte 8 Wochen, neueste zuerst, max. 10 ─────────────
    const cutoff = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const activities = (Array.isArray(allActivities) ? allActivities : [])
      .filter((a) => (a.date || "").slice(0, 10) >= cutoff)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 10);

    // ── Rennen: ab heute, max. 3 ──────────────────────────────────────────
    const heute = new Date().toISOString().slice(0, 10);
    const races = (Array.isArray(allRaces) ? allRaces : [])
      .filter((r) => (r.date || "") >= heute)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .slice(0, 3);

    // ── Kontext aufbauen ───────────────────────────────────────────────────
    const formatDur = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}:${String(m).padStart(2, "0")} h` : `${m} min`;
    };
    const sportLabel = {
      run: "Laufen",
      bike: "Rad",
      swim: "Schwimmen",
      misc: "Sonstiges",
    };

    const actLines = activities
      .map((a) => {
        // Legacy-Felder der alten Monolith abfangen (type/avgHr statt sport_type/avg_hr)
        const sportKey = a.sport_type || a.type || "";
        const sport = sportLabel[sportKey] || sportKey || "?";
        const dist = a.distance ? (a.distance / 1000).toFixed(1) + " km" : "";
        const dur = a.duration ? formatDur(a.duration) : "";
        const hrVal = a.avg_hr ?? a.avgHr;
        const hr = hrVal ? `HF ${Math.round(hrVal)}` : "";
        const teile = [sport, a.name || "", dist, dur, hr].filter(Boolean);
        return `• ${(a.date || "").slice(0, 10)} — ${teile.join(" — ")}`;
      })
      .join("\n");

    const raceLines = races
      .map((r) => {
        const tage = Math.round((new Date(r.date) - new Date()) / 86400000);
        return `• ${r.date} — ${r.name}${r.goal ? " — Ziel: " + r.goal : ""} (in ${tage} Tagen)`;
      })
      .join("\n");

    const kontext = [
      `Athlet: ${athleteName}`,
      `Heute: ${heute}`,
      "",
      "Letzte Trainingseinheiten (max. 10):",
      actLines || "(keine Aktivitäten in den letzten 8 Wochen)",
      "",
      "Nächste Wettkämpfe:",
      raceLines || "(keine)",
    ].join("\n");

    // ── Claude Sonnet aufrufen ─────────────────────────────────────────────
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: `${systemPrompt}\n\nTrainingsdaten:\n${kontext}`,
        messages: [{ role: "user", content: userText }],
      }),
    });

    const claudeData = await claudeRes.json();
    const antwort =
      claudeData.content?.[0]?.text ||
      "Ich konnte leider keine Antwort generieren.";

    // ── Antwort via Telegram senden ────────────────────────────────────────
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: antwort }),
      },
    );

    // Telegram erwartet immer 200, sonst retried er die Nachricht
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("telegram-coach error:", e);
    // Fehlermeldung an Telegram senden (Best-effort)
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "⚠️ Fehler beim Verarbeiten deiner Nachricht. Bitte versuche es erneut.",
        }),
      },
    ).catch(() => {});

    return res.status(200).json({ ok: true });
  }
}
