const express = require('express');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
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
let botsCol = null;
let kbCol = null; // knowledge base

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
    botsCol = db.collection('bots');
    kbCol = db.collection('knowledge_base');
    await messagesCol.createIndex({ customerPhone: 1, timestamp: 1 });
    await botsCol.createIndex({ isDefault: 1 });
    console.log('✅ MongoDB connected');
    await seedDefaultBot();
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

// ---------- Seed default bot if none exists ----------
async function seedDefaultBot() {
  if (!botsCol) return;
  const count = await botsCol.countDocuments({});
  if (count === 0) {
    await botsCol.insertOne({
      name: 'Afi',
      model: 'llama-3.1-8b-instant',
      description: 'GoGadAFI WhatsApp Assistant',
      systemPrompt: `You are Afi, GoGadAFI's WhatsApp assistant.
ABOUT GoGadAFI:
- Brand Name: GoGadAFI (always use this exact format)
- Founder: Neelakandan
- Type: Premium Men's Fashion Ecommerce Brand
- Location: Trichy, Tamil Nadu, India
- Website: https://gogad369.github.io/GOGADAFI
- WhatsApp: +91 93849 26539
- Customer Support Email: gogadafiofficial@gmail.com
STRICT RULES:
- Your name is Afi
- Always refer to brand as "GoGadAFI"
- ONLY answer questions related to GoGadAFI business
- If asked anything unrelated, reply: "Sorry, I don't have knowledge about it. I'm exclusively created for GoGadAFI"
- Reply in the same language the customer uses
- Keep replies short, 1-2 lines maximum`,
      isDefault: true,
      active: true,
      contextMessages: 10,
      messageWaitTime: 0,
      createdAt: new Date()
    });
    console.log('✅ Default bot "Afi" seeded');
  }
}

connectDB();

// ---------- DB helpers ----------
async function saveMessage({ customerPhone, customerName, text, direction, messageId }) {
  if (!messagesCol) return;
  try {
    await messagesCol.insertOne({
      customerPhone, customerName, text,
      direction, messageId: messageId || null,
      timestamp: new Date(),
      read: direction === 'incoming' ? false : true
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

// ---------- Get assigned bot for a customer ----------
async function getBotForCustomer(customerPhone) {
  if (!botsCol || !customersCol) return null;
  try {
    const customer = await customersCol.findOne({ customerPhone });
    let bot = null;
    if (customer?.assignedBotId) {
      bot = await botsCol.findOne({ _id: new ObjectId(customer.assignedBotId), active: true });
    }
    if (!bot) {
      bot = await botsCol.findOne({ isDefault: true, active: true });
    }
    if (!bot) {
      bot = await botsCol.findOne({ active: true });
    }
    return bot;
  } catch (err) {
    console.error('getBotForCustomer error:', err.message);
    return null;
  }
}

// ---------- Get knowledge base for a bot ----------
async function getKnowledgeBase(botId) {
  if (!kbCol || !botId) return null;
  try {
    return await kbCol.findOne({ botId: botId.toString() });
  } catch (err) {
    return null;
  }
}

// ---------- Build smart system prompt ----------
function buildSystemPrompt(bot, kb, customerName, isFirstTime) {
  let prompt = bot.systemPrompt || '';

  // Inject knowledge base
  if (kb) {
    let kbSection = '\n\n===== PRODUCT & BRAND KNOWLEDGE BASE =====';
    kbSection += '\nUse ONLY the information below when answering product/price/policy questions. Do NOT invent details.';

    if (kb.products?.length) {
      kbSection += '\n\nPRODUCTS:';
      kb.products.forEach(p => {
        kbSection += `\n- ${p.name}`;
        if (p.description) kbSection += `: ${p.description}`;
        if (p.price) kbSection += ` | Price: ₹${p.price}`;
        if (p.colors?.length) kbSection += ` | Colors: ${p.colors.join(', ')}`;
        if (p.sizes?.length) kbSection += ` | Sizes: ${p.sizes.join(', ')}`;
        if (p.models?.length) kbSection += ` | Models: ${p.models.join(', ')}`;
      });
    }

    if (kb.policies?.refund) {
      kbSection += `\n\nREFUND POLICY:\n${kb.policies.refund}`;
    }
    if (kb.policies?.shipping) {
      kbSection += `\n\nSHIPPING POLICY:\n${kb.policies.shipping}`;
    }
    if (kb.policies?.exchange) {
      kbSection += `\n\nEXCHANGE POLICY:\n${kb.policies.exchange}`;
    }
    if (kb.faqs?.length) {
      kbSection += '\n\nFAQs:';
      kb.faqs.forEach(f => {
        kbSection += `\nQ: ${f.q}\nA: ${f.a}`;
      });
    }
    if (kb.support) {
      kbSection += `\n\nSUPPORT INFO:\n${kb.support}`;
    }
    kbSection += '\n===== END OF KNOWLEDGE BASE =====';
    prompt += kbSection;
  }

  // Smart context rules
  prompt += `\n\nCONTEXT RULES:
- If the customer asks about a product, remember which product was discussed in previous messages and answer in context
- If customer asks "what colors?" or "what models?" refer to the last product mentioned
- For refund/return/exchange questions, give step-by-step instructions from the policy above
- For out-of-scope questions, politely redirect to GoGadAFI products/services`;

  // Welcome message for first-time
  if (isFirstTime) {
    prompt += `\n\n- This is the customer's first message. Start your reply with exactly:\n"Hi ${customerName}!\n\nWelcome to GoGadAFI! I'm ${bot.name || 'Afi'}, your WhatsApp assistant. How can I help you today?"`;
  } else {
    prompt += `\n\n- This is a returning customer, do NOT send welcome message, just answer their question directly`;
  }

  return prompt;
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

// =====================================================================
// API ROUTES — literal routes BEFORE parameterized routes
// =====================================================================

// ---------- Conversations ----------
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
          unread: { $cond: [{ $eq: ['$lastDirection', 'incoming'] }, 1, 0] }
        }
      },
      { $sort: { lastTime: -1 } }
    ]).toArray();
    res.json(conversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- All recent messages ----------
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

// ---------- Mark read ----------
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

// ---------- Stats ----------
app.get('/api/stats', authCheck, async (req, res) => {
  if (!messagesCol) return res.json({});
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [total, todayIn, todayOut, customers] = await Promise.all([
      messagesCol.countDocuments({}),
      messagesCol.countDocuments({ direction: 'incoming', timestamp: { $gte: today } }),
      messagesCol.countDocuments({ direction: 'outgoing', timestamp: { $gte: today } }),
      customersCol.countDocuments({})
    ]);
    res.json({ total, todayIn, todayOut, customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Messages for one customer ----------
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

// ---------- Send manual reply ----------
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

// =====================================================================
// BOT MANAGEMENT APIs
// =====================================================================

// GET all bots
app.get('/api/bots', authCheck, async (req, res) => {
  if (!botsCol) return res.json([]);
  try {
    const bots = await botsCol.find({}).sort({ createdAt: 1 }).toArray();
    res.json(bots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create new bot
app.post('/api/bots', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { name, model, description, systemPrompt, isDefault, contextMessages, messageWaitTime } = req.body;
    if (!name || !systemPrompt) return res.status(400).json({ error: 'name and systemPrompt required' });
    if (isDefault) {
      await botsCol.updateMany({}, { $set: { isDefault: false } });
    }
    const result = await botsCol.insertOne({
      name, model: model || 'llama-3.1-8b-instant',
      description: description || '',
      systemPrompt,
      isDefault: isDefault || false,
      active: true,
      contextMessages: contextMessages || 10,
      messageWaitTime: messageWaitTime || 0,
      createdAt: new Date()
    });
    res.json({ success: true, id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update bot
app.put('/api/bots/:id', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { name, model, description, systemPrompt, isDefault, active, contextMessages, messageWaitTime } = req.body;
    if (isDefault) {
      await botsCol.updateMany({}, { $set: { isDefault: false } });
    }
    await botsCol.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name, model, description, systemPrompt, isDefault, active, contextMessages, messageWaitTime, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE bot
app.delete('/api/bots/:id', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const bot = await botsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (bot?.isDefault) return res.status(400).json({ error: 'Cannot delete default bot' });
    await botsCol.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SET default bot
app.post('/api/bots/:id/set-default', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    await botsCol.updateMany({}, { $set: { isDefault: false } });
    await botsCol.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isDefault: true } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// BOT ASSIGNMENT APIs (per customer)
// =====================================================================

// GET assigned bot for customer
app.get('/api/assign-bot/:phone', authCheck, async (req, res) => {
  if (!customersCol) return res.json({ assignedBotId: null });
  try {
    const customer = await customersCol.findOne({ customerPhone: req.params.phone });
    res.json({ assignedBotId: customer?.assignedBotId || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST assign bot to customer
app.post('/api/assign-bot/:phone', authCheck, async (req, res) => {
  if (!customersCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { botId } = req.body;
    await customersCol.updateOne(
      { customerPhone: req.params.phone },
      { $set: { assignedBotId: botId || null } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// KNOWLEDGE BASE APIs
// =====================================================================

// GET knowledge base for a bot
app.get('/api/kb/:botId', authCheck, async (req, res) => {
  if (!kbCol) return res.json({});
  try {
    const kb = await kbCol.findOne({ botId: req.params.botId });
    res.json(kb || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST/PUT save knowledge base for a bot
app.post('/api/kb/:botId', authCheck, async (req, res) => {
  if (!kbCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { products, policies, faqs, support } = req.body;
    await kbCol.updateOne(
      { botId: req.params.botId },
      { $set: { botId: req.params.botId, products: products || [], policies: policies || {}, faqs: faqs || [], support: support || '', updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// WEBHOOK
// =====================================================================

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

const processedMessages = new Set();

// Message debounce — wait N seconds before replying to batch rapid messages
const pendingReplies = new Map(); // phone -> timer

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

    // Save incoming message immediately
    await saveMessage({ customerPhone, customerName, text: customerMessage, direction: 'incoming', messageId });

    // Get the bot assigned to this customer
    const bot = await getBotForCustomer(customerPhone);
    const waitTime = (bot?.messageWaitTime || 0) * 1000; // convert to ms

    // Clear any existing pending reply for this customer (debounce)
    if (pendingReplies.has(customerPhone)) {
      clearTimeout(pendingReplies.get(customerPhone));
    }

    // Schedule reply after waitTime
    const timer = setTimeout(async () => {
      pendingReplies.delete(customerPhone);
      try {
        await processAndReply(customerPhone, customerName, bot);
      } catch (err) {
        console.error('Delayed reply error:', err.message);
      }
    }, waitTime);

    pendingReplies.set(customerPhone, timer);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});
// Add color emojis to text
function addColorEmojis(text) {
  const colorMap = {
    'black': '⚫', 'white': '⚪', 'red': '🔴', 'blue': '🔵',
    'green': '🟢', 'yellow': '🟡', 'orange': '🟠', 'purple': '🟣',
    'brown': '🟤', 'pink': '🩷', 'grey': '🩶', 'gray': '🩶',
    'navy': '🔵', 'maroon': '🔴', 'cream': '🟡', 'beige': '🟤',
    'கருப்பு': '⚫', 'வெள்ளை': '⚪', 'சிவப்பு': '🔴',
    'நீலம்': '🔵', 'பச்சை': '🟢', 'மஞ்சள்': '🟡',
    'ஆரஞ்சு': '🟠', 'ரோஜா': '🩷', 'பழுப்பு': '🟤'
  };
  return text.replace(/\b(\w+)\b/g, (word) => {
    const lower = word.toLowerCase();
    return colorMap[lower] ? `${word} ${colorMap[lower]}` : word;
  });
}
// ---------- Process and send reply ----------
async function processAndReply(customerPhone, customerName, bot) {
  try {
    // Get the latest message from this customer (after debounce)
    const latestMsgs = await messagesCol
      .find({ customerPhone, direction: 'incoming' })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    if (!latestMsgs.length) return;
    const latestMessage = latestMsgs[0].text;

    const isFirstTime = !(await customersCol?.findOne({ customerPhone, firstSeen: { $exists: true } }));

    // Get knowledge base
    const kb = bot ? await getKnowledgeBase(bot._id) : null;

    // Build smart system prompt
    const systemPrompt = bot
      ? buildSystemPrompt(bot, kb, customerName, isFirstTime)
      : buildFallbackPrompt(customerName, isFirstTime);

    const contextLimit = bot?.contextMessages || 10;
    const history = await getHistory(customerPhone, contextLimit);

    const model = bot?.model || 'llama-3.1-8b-instant';

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: latestMessage }
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
const formattedReply = addColorEmojis(reply);
    await saveMessage({ customerPhone, customerName, text: formattedReply, direction: 'outgoing' });

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: customerPhone,
        type: 'text',
        text: { body: formattedReply }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('processAndReply error:', err.response?.data || err.message);
  }
}

// ---------- Fallback prompt (no bot in DB) ----------
function buildFallbackPrompt(customerName, isFirstTime) {
  return `You are Afi, GoGadAFI's WhatsApp assistant.
ABOUT GoGadAFI:
- Brand Name: GoGadAFI
- Founder: Neelakandan
- Type: Premium Men's Fashion Ecommerce Brand
- Location: Trichy, Tamil Nadu, India
- Website: https://gogad369.github.io/GOGADAFI
- WhatsApp: +91 93849 26539
- Email: gogadafiofficial@gmail.com
PRODUCTS: Men's Casual Wear, Formal Wear, Ethnic Wear, Accessories
RULES:
- Name: Afi
- ONLY GoGadAFI topics
- Reply in customer's language
- Short replies (1-2 lines)
${isFirstTime ? `- Start with: "Hi ${customerName}!\n\nWelcome to GoGadAFI! I'm Afi, your WhatsApp assistant. How can I help you today?"` : '- Returning customer, no welcome message'}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
