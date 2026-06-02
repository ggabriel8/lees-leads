const express = require('express');
const cors = require('cors');
const https = require('https');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const INSTANTLY_API_KEY = 'MTdiOGUzYjMtOTIzZC00NDI3LWJlM2QtODMxMjAxNTNkNTllOlJPTW5HRWNnS3dTRA==';
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::BIGINT
  )`);
  console.log('[DB] Ready');
}

async function readLeads() {
  const r = await pool.query('SELECT data FROM leads ORDER BY created_at DESC');
  return r.rows.map(r => r.data);
}

async function getLeadById(id) {
  const r = await pool.query('SELECT data FROM leads WHERE id=$1', [id]);
  return r.rows[0] ? r.rows[0].data : null;
}

async function upsertLead(lead) {
  await pool.query(
    'INSERT INTO leads(id, data, created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=$2',
    [lead.id, JSON.stringify(lead), lead.createdAt]
  );
}

function isDuplicate(leads, email) {
  if (!email) return false;
  return leads.some(l => l.email && l.email.toLowerCase() === email.toLowerCase());
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/leads', async (req, res) => {
  try { res.json(await readLeads()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', async (req, res) => {
  try {
    const leads = await readLeads();
    const { name, email, phone, property, source, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (isDuplicate(leads, email)) return res.status(409).json({ error: 'Duplicate email' });
    const lead = {
      id: 'lead_' + Date.now(),
      name, email: email || '', phone: phone || '', property: property || '',
      source: source || 'Manual', status: status || 'new',
      createdAt: Date.now(), calls: [], notes: [], followUpAt: null, emailSentAt: null,
    };
    await upsertLead(lead);
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const lead = await getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const updated = { ...lead, ...req.body };
    await upsertLead(updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/instantly', async (req, res) => {
  try {
    const data = req.body;
    const email = data.email || data.lead_email || (data.contact && data.contact.email) || '';
    const firstName = data.first_name || data.firstName || (data.contact && data.contact.first_name) || '';
    const lastName = data.last_name || data.lastName || (data.contact && data.contact.last_name) || '';
    const name = (firstName + ' ' + lastName).trim() || email.split('@')[0] || 'Unknown';
    const phone = data.phone || (data.contact && data.contact.phone) || '';
    const property = data.city || data.location || data.property || '';
    const replyText = data.reply_text || data.message || data.body || '';
    const leads = await readLeads();
    if (isDuplicate(leads, email)) return res.json({ status: 'duplicate' });
    const lead = {
      id: 'lead_instantly_' + Date.now(),
      name, email, phone, property, source: 'Instantly', status: 'new',
      createdAt: Date.now(), calls: [],
      notes: replyText ? [{ at: Date.now(), text: replyText }] : [],
      followUpAt: null, emailSentAt: null,
    };
    await upsertLead(lead);
    res.json({ status: 'ok', lead });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function instantlyFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.instantly.ai',
      path: '/api/v2/' + endpoint,
      headers: { 'Authorization': 'Bearer ' + INSTANTLY_API_KEY },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function pollInstantly() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await instantlyFetch(
      'emails?email_type=received&limit=100&sort_order=desc&min_timestamp_created=' + encodeURIComponent(since)
    );
    const items = result.items || [];
    const leads = await readLeads();
    let added = 0;
    for (const item of items) {
      const email = item.lead || item.from_address_email || '';
      if (!email || isDuplicate(leads, email)) continue;
      let name = email.split('@')[0];
      try {
        const ld = await instantlyFetch('leads?email=' + encodeURIComponent(email) + '&limit=1');
        const li = (ld.items || [])[0];
        if (li) {
          const fn = (li.first_name || '').trim();
          const ln = (li.last_name || '').trim();
          if (fn + ln) name = (fn + ' ' + ln).trim();
        }
      } catch (e) {}
      const replyText = (item.body && item.body.text) || item.content_preview || '';
      const lead = {
        id: 'lead_instantly_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name, email, phone: '', property: '', source: 'Instantly', status: 'new',
        createdAt: Date.now(), calls: [],
        notes: replyText ? [{ at: Date.now(), text: replyText }] : [],
        followUpAt: null, emailSentAt: null,
      };
      await upsertLead(lead);
      leads.push(lead);
      added++;
      console.log('[Poll] Added: ' + name + ' <' + email + '>');
    }
    if (added) console.log('[Poll] Done â ' + added + ' new lead(s)');
  } catch (e) {
    console.error('[Poll] Error:', e.message);
  }
}


app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ status: 'deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function start() {
  await initDB();
  app.listen(PORT, () => console.log("Lee's Leads on port " + PORT));
  pollInstantly();
  setInterval(pollInstantly, POLL_INTERVAL_MS);
}
start();
