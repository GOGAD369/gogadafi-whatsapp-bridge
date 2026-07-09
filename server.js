const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GEMINI_API_KEY,
  VERIFY_TOKEN
} = process.env;

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (!message || message.type !== 'text') return res.sendStatus(200);

    const customerMessage = message.text.body;
    const customerPhone = message.from;

    // Send to Gemini
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: `You are a helpful assistant for Gogadafi, a fashion ecommerce business in India selling clothing, apparel and accessories. Reply helpfully and concisely in the same language the customer uses.\n\nCustomer: ${customerMessage}`
          }]
        }]
      }
    );

    const reply = geminiResponse.data.candidates[0].content.parts[0].text;

    // Send reply via WhatsApp
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: customerPhone,
        type: 'text',
        text: { body: reply }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
