export default async function handler(req, res) {         
    // Vercel sendet Authorization-Header bei Cron-Jobs automatisch                                                                   
    const cronSecret = process.env.CRON_SECRET;             
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {                                                         
      return res.status(401).json({ error: 'Unauthorized' });                                                                         
    }
                                                                                                                                      
    const SUPABASE_URL = 'https://cpzdqgrqodvwtnqmusso.supabase.co';                                                                  
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
                                                                                                                                      
    const sbFetch = async (table) => {                      
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=data&limit=1`, {                                                 
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }                                                    
      });                                                                                                                             
      return r.json();                                                                                                                
    };                                                                                                                                
                                                            
    // 1. Settings laden                                                                                                              
    const settingsRows = await sbFetch('settings');
    const cfg = JSON.parse(settingsRows?.[0]?.data || '{}');                                                                          
    const claudeKey = cfg.claudeApiKey || process.env.CLAUDE_API_KEY;                                                                    
    const tgToken = cfg.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = cfg.telegramChatId || process.env.TELEGRAM_CHAT_ID;                                                                
    const coachPrompt = cfg.coachPrompt || 'Du bist Sebastians persönlicher Triathlon-Coach.';
                                                                                                                                      
    if (!claudeKey || !tgToken || !tgChat) {
      return res.status(500).json({ error: 'Missing config (claudeKey/telegramToken/telegramChatId)' });
    }                                                                                                                                 
   
    // 2. Aktivitäten der letzten 7 Tage                                                                                              
    const actRows = await sbFetch('activities');            
    const allActivities = JSON.parse(actRows?.[0]?.data || '[]');                                                                     
    const now = new Date();                                                                                                           
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];                                                                           
    const todayStr = now.toISOString().split('T')[0];       
    const weekActs = allActivities.filter(a => a.date >= weekAgoStr && a.date <= todayStr);                                           
                                                            
    // 3. Nächste Wettkämpfe                                                                                                          
    const raceRows = await sbFetch('races');                
    const allRaces = JSON.parse(raceRows?.[0]?.data || '[]');                                                                         
    const upcoming = allRaces                               
      .filter(r => r.date >= todayStr)                                                                                                
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 3);                                                                                                                   
                                                            
    // 4. Statistiken aufbereiten                                                                                                     
    const fmtType = t => ({ run: 'Laufen', bike: 'Radfahren', swim: 'Schwimmen', tri: 'Triathlon', other: 'Sonstige' }[t] || t);
    const fmtDur = s => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h > 0 ? `${h}h ${m}min` : `${m}min`; };   
    const fmtDist = m => m >= 1000 ? (m/1000).toFixed(1) + ' km' : m + ' m';                                                          
                                                                                                                                      
    const byType = {};                                                                                                                
    let totalDur = 0;                                                                                                                 
    for (const a of weekActs) {                             
      if (!byType[a.type]) byType[a.type] = { count: 0, dur: 0, dist: 0 };                                                            
      byType[a.type].count++;
      byType[a.type].dur += a.duration || 0;                                                                                          
      byType[a.type].dist += a.distance || 0;                                                                                         
      totalDur += a.duration || 0;
    }                                                                                                                                 
                                                            
    const statsLines = weekActs.length === 0                                                                                          
      ? 'Keine Trainingseinheiten diese Woche.'
      : [                                                                                                                             
          ...Object.entries(byType).map(([t, s]) =>         
            `${fmtType(t)}: ${s.count}x · ${fmtDur(s.dur)}${s.dist ? ' · ' + fmtDist(s.dist) : ''}`                                   
          ),                                                                                                                          
          `Gesamt: ${weekActs.length} Einheiten · ${fmtDur(totalDur)}`                                                                
        ].join('\n');                                                                                                                 
                                                            
    const actDetails = weekActs.map(a =>                                                                                              
      `• ${a.date} [${fmtType(a.type)}] ${a.name || ''}` +  
      (a.duration ? ` · ${fmtDur(a.duration)}` : '') +                                                                                
      (a.distance ? ` · ${fmtDist(a.distance)}` : '') +
      (a.avgHr ? ` · HF ${Math.round(a.avgHr)}` : '') +                                                                               
      (a.intensity ? ` · Intensität ${a.intensity}/5` : '') +
      (a.notes ? `\n  "${a.notes}"` : '')                                                                                             
    ).join('\n');                                                                                                                     
   
    const racesInfo = upcoming.length === 0                                                                                           
      ? 'Keine geplanten Wettkämpfe in Kürze.'              
      : upcoming.map(r => {                                                                                                           
          const days = Math.round((new Date(r.date) - now) / 86400000);
          return `• ${r.date} ${r.name || ''}${r.goal ? ' · Ziel: ' + r.goal : ''} (in ${days} Tagen)`;                               
        }).join('\n');                                                                                                                
                                                                                                                                      
    // 5. Claude aufrufen                                                                                                             
    const userMsg = [                                       
      `Trainingswoche ${weekAgoStr} bis ${todayStr}:`,                                                                                
      '',
      statsLines,                                                                                                                     
      '',                                                   
      'Einheiten im Detail:',
      actDetails || '(keine)',                                                                                                        
      '',                                                                                                                             
      'Nächste Wettkämpfe:',                                                                                                          
      racesInfo,                                                                                                                      
      '',                                                   
      'Gib eine motivierende Wochenzusammenfassung: was lief gut, was fällt auf, kurzer Ausblick auf nächste Woche. Maximal 5 kompakte Absätze, Telegram-freundliches Format.'                                                                                            
    ].join('\n');
                                                                                                                                      
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',                                                                                            
        'content-type': 'application/json'
      },                                                                                                                              
      body: JSON.stringify({                                
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,                                                                                                              
        system: coachPrompt + '\n\nSchreibe eine Wochenzusammenfassung. Nutze Emojis sparsam, kein HTML, kein Markdown-Fettdruck mit **, nur normalen Text.',                                                                                                            
        messages: [{ role: 'user', content: userMsg }]      
      })                                                                                                                              
    });                                                     
    const claudeData = await claudeRes.json();                                                                                        
    const summary = claudeData.content?.[0]?.text;          
    if (!summary) return res.status(500).json({ error: 'Claude failed', detail: claudeData });
                                                                                                                                      
    // KW berechnen
    const startOfYear = new Date(now.getFullYear(), 0, 1);                                                                            
    const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
                                                                                                                                      
    // 6. Telegram senden
    const msg = `📋 Wochenzusammenfassung KW${weekNum}\n\n${summary}`;                                                                
    const tgRes = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',                                                                                                                 
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text: msg })                                                                            
    });                                                     
                                                                                                                                      
    if (!tgRes.ok) {                                        
      const tgErr = await tgRes.json();
      return res.status(500).json({ error: 'Telegram failed', detail: tgErr });                                                       
    }
                                                                                                                                      
    return res.status(200).json({ ok: true, week: `${weekAgoStr} – ${todayStr}`, activities: weekActs.length });                      
  }
