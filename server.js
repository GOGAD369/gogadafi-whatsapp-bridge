const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GROQ_API_KEY,
  VERIFY_TOKEN
} = process.env;

// Track processed messages
const processedMessages = new Set();

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

    // Duplicate check
    const messageId = message.id;
    if (processedMessages.has(messageId)) return res.sendStatus(200);
    processedMessages.add(messageId);

    if (processedMessages.size > 100) processedMessages.clear();

    const customerMessage = message.text.body;
    const customerPhone = message.from;

    // Send to Groq
    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `You are a customer support assistant exclusively for GoGadAFI, a premium mens fashion brand in India.

ABOUT GoGadAFI:
- Brand Name: GoGadAFI (always use this exact format)
- Founder: Neelakandan
- Type: Premium Men's Fashion Ecommerce Brand
- Location: Trichy, Tamil Nadu, India
- Website: https://gogad369.github.io/GOGADAFI
- WhatsApp: +91 93849 26539
- Customer Support Email: gogadafiofficial@gmail.com

PRODUCTS WE SELL:
- Men's Casual Wear (T-shirts, Shirts, Jeans)
- Men's Formal Wear (Formal shirts, Trousers)
- Men's Ethnic Wear (Kurtas, Dhotis)
- Accessories (Belts, Wallets, Caps)

HOW TO ORDER:
- Visit our website: https://gogad369.github.io/GOGADAFI
- WhatsApp: +91 93849 26539
- Email: gogadafiofficial@gmail.com

STRICT RULES:
- Always refer to brand as "GoGadAFI" - never any other format
- ONLY answer questions related to GoGadAFI business
- If asked anything unrelated, reply: "Sorry, I don't have knowledge about it. I'm exclusively created for GoGadAFI 👑"
- Reply in the same language the customer uses
- Keep replies short, helpful and professional`
          },
          {
            role: 'user',
            content: customerMessage
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const reply = groqResponse.data.choices[0].message.content;

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
