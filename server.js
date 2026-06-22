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

// ── IMAGES (sans timeout) ─────────────────────────────────────
app.post('/api/images', async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY manquante' });

    const { imageUrl, productId, imageId, boutique } = req.body;
    const brandColors = boutique === 'luminaire' ? 'black #1b1b1b and white' : 'white, black and beige #edddc9';

    // 1. Analyser avec GPT-4o
    const analyzeRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 100,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
          { type: 'text', text: 'Does this image contain English text or measurements in inches? Reply ONLY with JSON: {"needs_edit": true/false}' }
        ]}]
      })
    });

    const analyzeData = await analyzeRes.json();
    if (!analyzeRes.ok) throw new Error('Analyse: ' + (analyzeData.error?.message || analyzeRes.status));

    const analysisText = analyzeData.choices?.[0]?.message?.content || '{}';
    let analysis = { needs_edit: false };
    try { analysis = JSON.parse(analysisText.replace(/```json|```/g,'').trim()); } catch(e) {}

    if (!analysis.needs_edit) {
      return res.json({ status: 'ok', needs_edit: false });
    }

    // 2. Télécharger l'image
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error('Téléchargement échoué: ' + imgRes.status);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    // 3. Éditer avec gpt-image-1 — multipart/form-data manuel, sans timeout
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const prompt = `Edit this product image: replace ALL English text with French translations, keeping the exact same layout, font style and positioning. Convert measurements from inches (in) to centimeters (cm). Keep the product photo completely identical. Use brand colors ${brandColors} for text. Do not modify anything else.`;

    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nmedium\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      imgBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ];
    const formBody = Buffer.concat(parts);

    const editRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': formBody.length.toString()
      },
      body: formBody
      // Pas de timeout — on attend autant que nécessaire
    });

    const editData = await editRes.json();
    if (!editRes.ok || !editData.data?.[0]?.b64_json) {
      throw new Error('Edit: ' + (editData.error?.message || JSON.stringify(editData).substring(0, 200)));
    }

    const newBase64 = editData.data[0].b64_json;

    // 4. Upload sur Shopify
    const uploadRes = await fetch(`${SHOPIFY_API}/products/${productId}/images/${imageId}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
      body: JSON.stringify({ image: { id: imageId, attachment: newBase64, filename: `product-fr-${imageId}.png` } })
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error('Upload: ' + JSON.stringify(uploadData.errors));

    res.json({ status: 'updated', needs_edit: true, newImageUrl: uploadData.image?.src });

  } catch(e) {
    console.error('Image error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoFiche server running on port ${PORT}`));
