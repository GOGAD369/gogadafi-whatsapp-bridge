const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GROQ_API_KEY,
  VERIFY_TOKEN,
  MONGODB_URI,
  DASHBOARD_PASSWORD
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
    await messagesCol.createIndex({ customerPhone: 1, timestamp: 1 });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}
connectDB();

async function saveMessage({ customerPhone, customerName, text, direction, messageId }) {
  if (!messagesCol) return;
  try {
    await messagesCol.insertOne({
      customerPhone, customerName, text,
      direction, messageId: messageId || null,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('DB save error:', err.message);
  }
}

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

async function checkFirstTime(customerPhone, customerName) {
  if (!customersCol) return true;
  try {
    const existing = await customersCol.findOne({ customerPhone });
    if (existing) return false;
    await customersCol.insertOne({
      customerPhone, customerName, firstSeen: new Date()
    });
    return true;
  } catch (err) {
    console.error('DB customer error:', err.message);
    return true;
  }
}

// ---------- Auth middleware ----------
function authCheck(req, res, next) {
  const token = req.headers['x-dashboard-token'];
  const pwd = DASHBOARD_PASSWORD || 'gogadafi2026';
  if (token !== pwd) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------- Dashboard HTML ----------
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ---------- API: conversations list ----------
app.get('/api/conversations', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const conversations = await messagesCol.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$customerPhone',
          customerName: { $first: '$customerName' },
          lastMessage: { $first: '$text' },
          lastDirection: { $first: '$direction' },
          lastTime: { $first: '$timestamp' },
          totalMessages: { $sum: 1 }
        }
      },
      {
        $addFields: {
          unread: {
            $cond: [{ $eq: ['$lastDirection', 'incoming'] }, 1, 0]
          }
        }
      },
      { $sort: { lastTime: -1 } }
    ]).toArray();
    res.json(conversations);
  } catch (err) {
    console.error('Conversations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: messages for one customer ----------
app.get('/api/messages/:phone', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const messages = await messagesCol
      .find({ customerPhone: req.params.phone })
      .sort({ timestamp: 1 })
      .toArray();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: send manual reply ----------
app.post('/api/send', authCheck, async (req, res) => {
  const { phone, message, customerName } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    await saveMessage({
      customerPhone: phone,
      customerName: customerName || 'Unknown',
      text: message,
      direction: 'outgoing',
      messageId: null
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

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

    const messageId = message.id;
    if (processedMessages.has(messageId)) return res.sendStatus(200);
    processedMessages.add(messageId);
    if (processedMessages.size > 100) processedMessages.clear();

    const customerMessage = message.text.body;
    const customerPhone = message.from;
    const customerName = changes?.value?.contacts?.[0]?.profile?.name || 'there';

    const isFirstTime = await checkFirstTime(customerPhone, customerName);

    await saveMessage({
      customerPhone, customerName,
      text: customerMessage,
      direction: 'incoming',
      messageId
    });

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

    await saveMessage({
      customerPhone, customerName,
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
// All messages endpoint
app.get('/api/messages/all-recent', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const messages = await messagesCol
      .find({})
      .sort({ timestamp: -1 })
      .limit(500)
      .toArray();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark as read
app.post('/api/mark-read/:phone', authCheck, async (req, res) => {
  if (!messagesCol) return res.json({ success: true });
  try {
    await messagesCol.updateMany(
      { customerPhone: req.params.phone, direction: 'incoming', read: { $ne: true } },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats endpoint
app.get('/api/stats', authCheck, async (req, res) => {
  if (!messagesCol) return res.json({});
  try {
    const today = new Date();
    today.setHours(0,0,0,0);
    const [total, todayIn, todayOut, customers] = await Promise.all([
      messagesCol.countDocuments({}),
      messagesCol.countDocuments({ direction:'incoming', timestamp:{ $gte: today } }),
      messagesCol.countDocuments({ direction:'outgoing', timestamp:{ $gte: today } }),
      customersCol.countDocuments({})
    ]);
    res.json({ total, todayIn, todayOut, customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const processedMessages = new Set();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
