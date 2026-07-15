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
let kbCol = null;

async function connectDB() {
  if (!MONGODB_URI) { console.warn('⚠️  MONGODB_URI not set — running without DB'); return; }
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

async function seedDefaultBot() {
  if (!botsCol) return;
  const count = await botsCol.countDocuments({});
  if (count === 0) {
    await botsCol.insertOne({
      name: 'Afi',
      model: 'llama-3.1-8b-instant',
      description: 'GoGadAFI WhatsApp Assistant',
      systemPrompt: buildDefaultSystemPrompt(),
      isDefault: true,
      active: true,
      contextMessages: 10,
      messageWaitTime: 0,
      createdAt: new Date()
    });
    console.log('✅ Default bot "Afi" seeded');
  }
}

function buildDefaultSystemPrompt() {
  return `You are Afi, GoGadAFI's WhatsApp support assistant.

ABOUT GoGadAFI:
- Brand: GoGadAFI (Premium Men's Fashion)
- Founder: Neelakandan
- Location: Trichy, Tamil Nadu, India
- Website: https://gogad369.github.io/GOGADAFI
- WhatsApp: +91 93849 26539
- Email: gogadafiofficial@gmail.com

YOUR IDENTITY:
- Your name is Afi
- You are a WhatsApp assistant for GoGadAFI
- You help customers with product info, orders, and support

STRICT RULES:
1. NEVER invent product names, prices, order details, payment status, or tracking info
2. NEVER say "payment has been sent", "your order is confirmed" unless it's in your knowledge base
3. If you don't have specific product/price info, say: "Please contact us at +91 93849 26539 for details"
4. ONLY answer GoGadAFI related questions
5. For unrelated questions: "I can only help with GoGadAFI related queries 😊"
6. Reply in the SAME language the customer uses (Tamil or English)
7. Keep replies SHORT — max 3-4 lines
8. Be friendly and helpful
9. For greetings like "Hi", "Hello", "Hey" — respond warmly and ask how you can help`;
}

connectDB();

// ---------- DB helpers ----------
async function saveMessage({ customerPhone, customerName, text, direction, messageId, status }) {
  if (!messagesCol) return null;
  try {
    const result = await messagesCol.insertOne({
      customerPhone, customerName, text,
      direction, messageId: messageId || null,
      timestamp: new Date(),
      read: direction === 'incoming' ? false : true,
      status: status || (direction === 'outgoing' ? 'sent' : null)
    });
    return result.insertedId;
  } catch (err) {
    console.error('DB save error:', err.message);
    return null;
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
    await customersCol.insertOne({ customerPhone, customerName, firstSeen: new Date() });
    return true;
  } catch (err) {
    console.error('DB customer error:', err.message);
    return true;
  }
}

async function getBotForCustomer(customerPhone) {
  if (!botsCol || !customersCol) return null;
  try {
    const customer = await customersCol.findOne({ customerPhone });
    let bot = null;
    if (customer?.assignedBotId) {
      bot = await botsCol.findOne({ _id: new ObjectId(customer.assignedBotId), active: true });
    }
    if (!bot) bot = await botsCol.findOne({ isDefault: true, active: true });
    if (!bot) bot = await botsCol.findOne({ active: true });
    return bot;
  } catch (err) {
    console.error('getBotForCustomer error:', err.message);
    return null;
  }
}

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
  let prompt = bot.systemPrompt || buildDefaultSystemPrompt();

  // Inject knowledge base if available
  if (kb && (kb.products?.length || kb.faqs?.length || kb.policies?.refund)) {
    let kbSection = '\n\n===== PRODUCT & BRAND KNOWLEDGE BASE =====';
    kbSection += '\nUse ONLY this information for product/price/policy questions. Do NOT invent any details not listed here.';

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

    if (kb.policies?.refund) kbSection += `\n\nREFUND POLICY:\n${kb.policies.refund}`;
    if (kb.policies?.shipping) kbSection += `\n\nSHIPPING POLICY:\n${kb.policies.shipping}`;
    if (kb.policies?.exchange) kbSection += `\n\nEXCHANGE POLICY:\n${kb.policies.exchange}`;

    if (kb.faqs?.length) {
      kbSection += '\n\nFAQs:';
      kb.faqs.forEach(f => { kbSection += `\nQ: ${f.q}\nA: ${f.a}`; });
    }
    if (kb.support) kbSection += `\n\nSUPPORT:\n${kb.support}`;
    kbSection += '\n\nIMPORTANT: If a customer asks about a product, price, or order detail NOT listed above, say "Please contact us at +91 93849 26539 for more details" — do NOT make up information.';
    kbSection += '\n===== END OF KNOWLEDGE BASE =====';
    prompt += kbSection;
  } else {
    // No KB — add strict anti-hallucination rule
    prompt += '\n\nIMPORTANT: You do NOT have specific product details or prices loaded. If asked about specific products, prices, or availability, tell the customer to contact us at +91 93849 26539 or visit https://gogad369.github.io/GOGADAFI for details. Do NOT invent product info.';
  }

  // Context rules
  prompt += `\n\nCONVERSATION RULES:
- For greetings (Hi, Hello, Hey, Hai, வணக்கம்): respond warmly and ask how you can help — NEVER say "I don't have knowledge about it" for a greeting
- If customer asks about a product discussed earlier in the conversation, refer to that context
- For payment/order confirmation: ONLY confirm if you have actual data; otherwise say "Please contact us to verify your order status"
- For shipping/tracking: say "Our team will update you shortly. For immediate help: +91 93849 26539"`;

  // Welcome message for first-time
  if (isFirstTime) {
    prompt += `\n\nFIRST MESSAGE: Start your reply with: "Hi ${customerName}! 👋\n\nWelcome to GoGadAFI 🛍️ I am Afi, your WhatsApp assistant. How can I help you today?"`;
  } else {
    prompt += `\n\nRETURNING CUSTOMER: Do NOT send welcome message. Answer their question directly.`;
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

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// =====================================================================
// API ROUTES
// =====================================================================

app.get('/api/conversations', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const conversations = await messagesCol.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: {
          _id: '$customerPhone',
          customerName: { $first: '$customerName' },
          lastMessage: { $first: '$text' },
          lastDirection: { $first: '$direction' },
          lastTime: { $first: '$timestamp' },
          totalMessages: { $sum: 1 }
      }},
      { $addFields: { unread: { $cond: [{ $eq: ['$lastDirection', 'incoming'] }, 1, 0] } }},
      { $sort: { lastTime: -1 } }
    ]).toArray();
    res.json(conversations);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/all-recent', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const messages = await messagesCol.find({}).sort({ timestamp: -1 }).limit(500).toArray();
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mark-read/:phone', authCheck, async (req, res) => {
  if (!messagesCol) return res.json({ success: true });
  try {
    await messagesCol.updateMany(
      { customerPhone: req.params.phone, direction: 'incoming', read: { $ne: true } },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', authCheck, async (req, res) => {
  if (!messagesCol) return res.json({});
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [total, todayIn, todayOut, customers] = await Promise.all([
      messagesCol.countDocuments({}),
      messagesCol.countDocuments({ direction: 'incoming', timestamp: { $gte: today } }),
      messagesCol.countDocuments({ direction: 'outgoing', timestamp: { $gte: today } }),
      customersCol.countDocuments({})
    ]);
    res.json({ total, todayIn, todayOut, customers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/:phone', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const messages = await messagesCol
      .find({ customerPhone: req.params.phone })
      .sort({ timestamp: 1 })
      .toArray();
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Send manual reply ----------
app.post('/api/send', authCheck, async (req, res) => {
  const { phone, message, customerName } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    const waRes = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const waMessageId = waRes.data?.messages?.[0]?.id || null;
    await saveMessage({
      customerPhone: phone,
      customerName: customerName || 'Unknown',
      text: message,
      direction: 'outgoing',
      messageId: waMessageId,
      status: 'sent'
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Send WhatsApp template message ----------
app.post('/api/send-template', authCheck, async (req, res) => {
  const {
    phone,               // required — recipient WhatsApp number, e.g. "919384926539"
    templateName,        // optional — defaults to 'intern_recruiting'
    languageCode,        // optional — defaults to 'en'
    customerName,        // required — fills header {{1}}
    referredBy           // required — fills body {{2}}
  } = req.body;

  if (!phone || !customerName || !referredBy) {
    return res.status(400).json({ error: 'phone, customerName and referredBy are required' });
  }

  const template = templateName || 'intern_recruiting';
  const lang = languageCode || 'en';

  try {
    const waRes = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: template,
          language: { code: lang },
          components: [
            {
              type: 'header',
              parameters: [
                { type: 'text', text: customerName }
              ]
            },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: referredBy }
              ]
            }
          ]
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const waMessageId = waRes.data?.messages?.[0]?.id || null;

    // Log a readable summary in the chat history so it shows in the dashboard
    await saveMessage({
      customerPhone: phone,
      customerName: customerName,
      text: `[Template: ${template}] Header: ${customerName} | Referred by: ${referredBy}`,
      direction: 'outgoing',
      messageId: waMessageId,
      status: 'sent'
    });

    res.json({ success: true, messageId: waMessageId });
  } catch (err) {
    console.error('Template send error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// =====================================================================
// BOT MANAGEMENT APIs
// =====================================================================

app.get('/api/bots', authCheck, async (req, res) => {
  if (!botsCol) return res.json([]);
  try { res.json(await botsCol.find({}).sort({ createdAt: 1 }).toArray()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bots', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { name, model, description, systemPrompt, isDefault, contextMessages, messageWaitTime } = req.body;
    if (!name || !systemPrompt) return res.status(400).json({ error: 'name and systemPrompt required' });
    if (isDefault) await botsCol.updateMany({}, { $set: { isDefault: false } });
    const result = await botsCol.insertOne({
      name, model: model || 'llama-3.1-8b-instant',
      description: description || '', systemPrompt,
      isDefault: isDefault || false, active: true,
      contextMessages: contextMessages || 10,
      messageWaitTime: messageWaitTime || 0,
      createdAt: new Date()
    });
    res.json({ success: true, id: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bots/:id', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { name, model, description, systemPrompt, isDefault, active, contextMessages, messageWaitTime } = req.body;
    if (isDefault) await botsCol.updateMany({}, { $set: { isDefault: false } });
    await botsCol.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name, model, description, systemPrompt, isDefault, active, contextMessages, messageWaitTime, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bots/:id', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const bot = await botsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (bot?.isDefault) return res.status(400).json({ error: 'Cannot delete default bot' });
    await botsCol.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bots/:id/set-default', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    await botsCol.updateMany({}, { $set: { isDefault: false } });
    await botsCol.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isDefault: true } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/assign-bot/:phone', authCheck, async (req, res) => {
  if (!customersCol) return res.json({ assignedBotId: null });
  try {
    const customer = await customersCol.findOne({ customerPhone: req.params.phone });
    res.json({ assignedBotId: customer?.assignedBotId || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/kb/:botId', authCheck, async (req, res) => {
  if (!kbCol) return res.json({});
  try { res.json(await kbCol.findOne({ botId: req.params.botId }) || {}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =====================================================================
// WEBHOOK
// =====================================================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

const processedMessages = new Set();
const pendingReplies = new Map();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond immediately
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];

    // ── Handle message STATUS updates (for ticks) ──
    const statuses = changes?.value?.statuses;
    if (statuses?.length) {
      for (const s of statuses) {
        const { id: msgId, status, recipient_id } = s;
        // status: 'sent' | 'delivered' | 'read'
        if (messagesCol && msgId) {
          try {
            await messagesCol.updateOne(
              { messageId: msgId },
              { $set: { status, statusUpdatedAt: new Date() } }
            );
          } catch(e) { console.error('status update error:', e.message); }
        }
      }
      return;
    }

    const message = changes?.value?.messages?.[0];
    if (!message) return;

    // Handle non-text messages (image, audio, file, video, sticker)
    if (message.type !== 'text') {
      const customerPhone = message.from;
      const customerName = changes?.value?.contacts?.[0]?.profile?.name || 'Customer';

      const replyMap = {
        image: `Hi ${customerName}! 📸 I'd love to help you with that! But currently I'm unable to view or process images. Please describe what you're looking for in text and I'll be happy to assist! 😊`,
        audio: `Hi ${customerName}! 🎤 I'd love to help you! But currently I'm unable to listen to voice messages. Please type your question and I'll get back to you right away! 😊`,
        video: `Hi ${customerName}! 🎥 I'd love to help! But currently I'm unable to play videos. Please type your question and I'll assist you! 😊`,
        document: `Hi ${customerName}! 📄 I'd love to help you with that! But currently I'm unable to open files or documents. Please type your question directly and I'll assist you right away! 😊`,
        sticker: `Hey ${customerName}! 😄 Thanks for the sticker! How can I help you with GoGadAFI today?`,
      };
      const reply = replyMap[message.type] || `Hi ${customerName}! I'm unable to process this type of message. Please type your question and I'll help you! 😊`;

      try {
        const waRes = await axios.post(
          `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
          { messaging_product: 'whatsapp', to: customerPhone, type: 'text', text: { body: reply } },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        await saveMessage({ customerPhone, customerName, text: reply, direction: 'outgoing', messageId: waRes.data?.messages?.[0]?.id, status: 'sent' });
      } catch(e) { console.error('non-text reply error:', e.message); }
      return;
    }

    // Text message handling
    const messageId = message.id;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);
    if (processedMessages.size > 200) processedMessages.clear();

    const customerMessage = message.text.body;
    const customerPhone = message.from;
    const customerName = changes?.value?.contacts?.[0]?.profile?.name || 'Customer';

    await saveMessage({ customerPhone, customerName, text: customerMessage, direction: 'incoming', messageId });

    const bot = await getBotForCustomer(customerPhone);
    const waitTime = (bot?.messageWaitTime || 0) * 1000;

    if (pendingReplies.has(customerPhone)) clearTimeout(pendingReplies.get(customerPhone));

    const timer = setTimeout(async () => {
      pendingReplies.delete(customerPhone);
      try { await processAndReply(customerPhone, customerName, bot); }
      catch (err) { console.error('Delayed reply error:', err.message); }
    }, waitTime);

    pendingReplies.set(customerPhone, timer);
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
  }
});

// ---------- Color emojis ----------
function addColorEmojis(text) {
  const colorMap = {
    'black':'⚫','white':'⚪','red':'🔴','blue':'🔵','green':'🟢',
    'yellow':'🟡','orange':'🟠','purple':'🟣','brown':'🟤','pink':'🩷',
    'grey':'🩶','gray':'🩶','navy':'🔵','maroon':'🔴','cream':'🟡','beige':'🟤',
    'கருப்பு':'⚫','வெள்ளை':'⚪','சிவப்பு':'🔴','நீலம்':'🔵',
    'பச்சை':'🟢','மஞ்சள்':'🟡','ஆரஞ்சு':'🟠','ரோஜா':'🩷','பழுப்பு':'🟤'
  };
  return text.replace(/\b(\w+)\b/g, (word) => {
    const lower = word.toLowerCase();
    return colorMap[lower] ? `${word} ${colorMap[lower]}` : word;
  });
}

// ---------- Process and send reply ----------
async function processAndReply(customerPhone, customerName, bot) {
  try {
    const latestMsgs = await messagesCol
      .find({ customerPhone, direction: 'incoming' })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    if (!latestMsgs.length) return;
    const latestMessage = latestMsgs[0].text;

    // Check first time BEFORE any other processing
    const isFirstTime = await checkFirstTime(customerPhone, customerName);

    const kb = bot ? await getKnowledgeBase(bot._id) : null;
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
        ],
        temperature: 0.4, // Lower temp = less hallucination
        max_tokens: 300
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    let reply = groqResponse.data.choices[0].message.content;
    reply = addColorEmojis(reply);

    // Save outgoing message and get WA message ID for status tracking
    const waRes = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: customerPhone, type: 'text', text: { body: reply } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const waMessageId = waRes.data?.messages?.[0]?.id || null;
    await saveMessage({ customerPhone, customerName, text: reply, direction: 'outgoing', messageId: waMessageId, status: 'sent' });

  } catch (err) {
    console.error('processAndReply error:', err.response?.data || err.message);
  }
}

function buildFallbackPrompt(customerName, isFirstTime) {
  return `You are Afi, GoGadAFI's WhatsApp assistant.
GoGadAFI is a Premium Men's Fashion brand in Trichy, Tamil Nadu.
Website: https://gogad369.github.io/GOGADAFI | WhatsApp: +91 93849 26539

RULES:
- Name: Afi
- ONLY GoGadAFI topics
- Reply in customer's language
- Short replies (2-3 lines)
- NEVER invent product details, prices, or order status
- For greetings, respond warmly
- For specific product/price queries, direct to: +91 93849 26539
${isFirstTime
  ? `- Start with: "Hi ${customerName}! 👋\n\nWelcome to GoGadAFI 🛍️ I am Afi, your WhatsApp assistant. How can I help you today?"`
  : '- Returning customer, answer directly without welcome message'}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
