const express = require('express');
const cors = require('cors');
const https = require('https');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTANTLY_API_KEY = '>>REMOVED_USE_ENV_VAR==';
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

async function initDB() {
  await pool.query('CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, data JSONB NOT NULL)');
  console.log('[DB] Table ready');
  const { rows } = await pool.query('SELECT COUNT(*) FROM leads');
  if (parseInt(rows[0].count) === 0) await seedLeads();
}

async function seedLeads() {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, 'leads.json');
  if (!fs.existsSync(file)) return;
  try {
    const leads = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const lead of leads)
      await pool.query('INSERT INTO leads (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [lead.id, JSON.stringify(lead)]);
    console.log('[DB] Seeded ' + leads.length + ' leads');
  } catch(e) { console.error('[DB] Seed error:', e.message); }
}

async function readLeads() {
  const { rows } = await pool.query("SELECT data FROM leads ORDER BY (data->>'createdAt')::bigint DESC");
  return rows.map(r => r.data);
}

async function updateLead(id, patch) {
  const { rows } = await pool.query('SELECT data FROM leads WHERE id = $1', [id]);
  if (!rows.length) return null;
  const updated = { ...rows[0].data, ...patch };
  await pool.query('UPDATE leads SET data = $1 WHERE id = $2', [JSON.stringify(updated), id]);
  return updated;
}

function isDuplicate(leads, email) {
  if (!email) return false;
  return leads.some(l => l.email && l.email.toLowerCase() === email.toLowerCase());
}

app.get('/api/leads', async (req, res) => {
  try { res.json(await readLeads()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', async (req, res) => {
  try {
    const leads = await readLeads();
    const { name, email, phone, property, source, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (isDuplicate(leads, email)) return res.status(409).json({ error: 'Duplicate email' });
    const lead = { id: 'lead_' + Date.now(), name, email: email||'', phone: phone||'', property: property||'', source: source||'Manual', status: status||'new', createdAt: Date.now(), calls: [], notes: [], followUpAt: null, emailSentAt: null };
    await pool.query('INSERT INTO leads (id, data) VALUES ($1, $2)', [lead.id, JSON.stringify(lead)]);
    res.json(lead);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const updated = await updateLead(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function instantlyFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.instantly.ai', path: '/api/v2/' + endpoint, method: 'GET', headers: { 'Authorization': 'Bearer ' + INSTANTLY_API_KEY } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function pollInstantly() {
  try {
    console.log('[Instantly Poll] Checking...');
    const since = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    const result = await instantlyFetch('emails?email_type=received&limit=100&sort_order=desc&min_timestamp_created=' + encodeURIComponent(since));
    const items = result.items || [];
    if (!items.length) { console.log('[Instantly Poll] No new replies.'); return; }
    const leads = await readLeads();
    let added = 0;
    for (const item of items) {
      const email = item.lead || item.from_address_email || '';
      if (!email || isDuplicate(leads, email)) continue;
      let name = email.split('@')[0];
      try {
        const ld = await instantlyFetch('leads?email=' + encodeURIComponent(email) + '&limit=1');
        const li = ld.items || [];
        if (li.length) { const fn=li[0].first_name||''; const ln=li[0].last_name||''; if((fn+ln).trim()) name=(fn+' '+ln).trim(); }
      } catch(e) {}
      const replyText = (item.body && item.body.text) || item.content_preview || '';
      const lead = { id: 'lead_instantly_' + Date.now() + '_' + Math.random().toString(36).slice(2), name, email, phone: '', property: '', source: 'Instantly', status: 'new', createdAt: Date.now(), calls: [], notes: replyText ? [{at:Date.now(),text:replyText}] : [], followUpAt: null, emailSentAt: null };
      await pool.query('INSERT INTO leads (id, data) VALUES ($1, $2)', [lead.id, JSON.stringify(lead)]);
      leads.push(lead);
      added++;
      console.log('[Instantly Poll] Added: ' + name + ' <' + email + '>');
    }
    console.log('[Instantly Poll] Done - ' + added + ' new lead(s).');
  } catch(err) { console.error('[Instantly Poll] Error:', err.message); }
}

app.listen(PORT, async () => {
  console.log('Lee\'s Leads running at http://localhost:' + PORT);
  await initDB();
  pollInstantly();
  setInterval(pollInstantly, POLL_INTERVAL_MS);
});
