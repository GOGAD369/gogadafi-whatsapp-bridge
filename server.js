const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GROQ_API_KEY,
  VERIFY_TOKEN,
  MONGODB_URI
} = process.env;

// ---------- MongoDB setup ----------
let db = null;
let messagesCol = null;
let customersCol = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not set — running without DB');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('gogadafi');
    messagesCol = db.collection('messages');
    customersCol = db.collection('customers');
    // Index for faster conversation lookups
    await messagesCol.createIndex({ customerPhone: 1, timestamp: 1 });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}
connectDB();

// Save one message (incoming or outgoing)
async function saveMessage({ customerPhone, customerName, text, direction, messageId }) {
  if (!messagesCol) return;
  try {
    await messagesCol.insertOne({
      customerPhone,
      customerName,
      text,
      direction,          // 'incoming' or 'outgoing'
      messageId: messageId || null,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('DB save error:', err.message);
  }
}

// Get last N messages for a customer (for Groq context)
async function getHistory(customerPhone, limit = 10) {
  if (!messagesCol) return [];
  try {
    const docs = await messagesCol
      .find({ customerPhone })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse().map(d => ({
      role: d.direction === 'incoming' ? 'user' : 'assistant',
      content: d.text
    }));
  } catch (err) {
    console.error('DB history error:', err.message);
    return [];
  }
}

// Check + mark first-time customer (persistent)
async function checkFirstTime(customerPhone, customerName) {
  if (!customersCol) return true; // no DB → treat as first time
  try {
    const existing = await customersCol.findOne({ customerPhone });
    if (existing) return false;
    await customersCol.insertOne({
      customerPhone,
      customerName,
      firstSeen: new Date()
    });
    return true;
  } catch (err) {
    console.error('DB customer error:', err.message);
    return true;
  }
}

// ---------- Duplicate tracking (in-memory) ----------
const processedMessages = new Set();

// ---------- Webhook verify ----------
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

// ---------- Webhook receive ----------
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
    const customerName = changes?.value?.contacts?.[0]?.profile?.name || 'there';

    // First time check (persistent via DB)
    const isFirstTime = await checkFirstTime(customerPhone, customerName);

    // Save incoming message
    await saveMessage({
      customerPhone,
      customerName,
      text: customerMessage,
      direction: 'incoming',
      messageId
    });

    // Build system prompt
    const systemPrompt = `You are Aafia, GoGadAFI's WhatsApp assistant.

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
- Your name is Aafia
- Always refer to brand as "GoGadAFI" - never any other format
- ONLY answer questions related to GoGadAFI business
- If asked anything unrelated, reply: "Sorry, I don't have knowledge about it. I'm exclusively created for GoGadAFI"
- Reply in the same language the customer uses
- Keep replies short, 1-2 lines maximum
${isFirstTime ? `- This is the customer's first message. Start your reply with exactly:\n"Hi ${customerName}!\n\nWelcome to GoGadAFI! I'm Aafia, your WhatsApp assistant. How can I help you today?"` : '- This is a returning customer, do NOT send welcome message, just answer their question directly'}`;

    // Get recent history for context (excludes the just-saved incoming msg on old DBs; fine either way)
    const history = await getHistory(customerPhone, 10);

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: customerMessage }
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

    // Save outgoing message
    await saveMessage({
      customerPhone,
      customerName,
      text: reply,
      direction: 'outgoing'
    });

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
