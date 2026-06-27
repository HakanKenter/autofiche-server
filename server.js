const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SHOPIFY_API = `https://${SHOPIFY_STORE}/admin/api/2024-01`;

// ── SANTÉ ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AutoFiche server running' }));

// ── SHOPIFY PROXY ─────────────────────────────────────────────
app.all('/api/shopify/*', async (req, res) => {
  try {
    const path = req.path.replace('/api/shopify', '');
    const url = `${SHOPIFY_API}${path}`;
    const options = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      }
    };
    if (['PUT', 'POST'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }
    const shopRes = await fetch(url, options);
    const data = await shopRes.json();
    res.status(shopRes.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLAUDE PROXY ──────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });
    const body = { ...req.body, model: 'claude-sonnet-4-6', max_tokens: 4000 };
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await claudeRes.json();
    res.status(claudeRes.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GPT-4o PROXY ─────────────────────────────────────────────────────────
app.post('/api/gpt', async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY manquante' });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANALYZE IMAGE (détection texte anglais uniquement) ───────────
app.post('/api/analyze-image', async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY manquante' });
    const { imageUrl } = req.body;

    const analyzeRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 100,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
          { type: 'text', text: 'Does this image contain English text overlays, English labels, or measurements in inches (in, ")? Do NOT count brand names or product model numbers. Reply ONLY with JSON: {"needs_edit": true/false}' }
        ]}]
      })
    });

    const data = await analyzeRes.json();
    if (!analyzeRes.ok) throw new Error(data.error?.message || analyzeRes.status);

    const text = data.choices?.[0]?.message?.content || '{}';
    let result = { needs_edit: false };
    try { result = JSON.parse(text.replace(/```json|```/g,'').trim()); } catch(e) {}

    res.json(result);
  } catch(e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: e.message, needs_edit: false });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoFiche server running on port ${PORT}`));
