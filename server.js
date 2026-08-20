const express = require('express');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GROQ_API_KEY,
  VERIFY_TOKEN,
  MONGODB_URI,
  FIREBASE_SERVICE_ACCOUNT, // full JSON of the downloaded service account key, as a single-line string
  SESSION_SECRET            // any long random string — used to sign our own session tokens
} = process.env;

// ---------- Admin emails ----------
// Anyone signing in with one of these emails becomes role: 'admin'.
// Everyone else becomes role: 'client'.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);
// Fallback if ADMIN_EMAILS env var isn't set yet — replace with your real email.
if (ADMIN_EMAILS.length === 0) {
  ADMIN_EMAILS.push('neelakandan.afi@gmail.com');
}

// ---------- Firebase Admin setup ----------
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — login will not work');
} else {
  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized');
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin:', err.message);
  }
}

if (!SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET not set — using an insecure default. Set this in Render!');
}
const SESSION_SECRET_VALUE = SESSION_SECRET || 'insecure-dev-secret-change-me';

// ---------- MongoDB setup ----------
let db = null;
let messagesCol = null;
let customersCol = null;
let botsCol = null;
let kbCol = null;
let usersCol = null;

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
    usersCol = db.collection('users');
    await messagesCol.createIndex({ customerPhone: 1, timestamp: 1 });
    await botsCol.createIndex({ isDefault: 1 });
    await usersCol.createIndex({ uid: 1 }, { unique: true });
    await usersCol.createIndex({ email: 1 }, { unique: true });
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
      systemPrompt: `You are Afi, GoGadAFI's WhatsApp assistant.

ABOUT GoGadAFI:
- Brand Name: GoGadAFI (always use this exact format)
- Founder: Neelakandan
- Type: Digital Marketing Agency & WhatsApp API Provider
- Location: Trichy, Tamil Nadu, India
- Website: https://gogadafi.in
- WhatsApp: +91 93849 26539
- Email: gogadafiofficial@gmail.com

SERVICES:
- Social Media Marketing (Instagram, Facebook, LinkedIn)
- Meta Ads (Facebook & Instagram Ads)
- Google Ads
- SEO (Search Engine Optimization)
- Website Design & Development
- WhatsApp API Automation

MAIN PRODUCT — AFI Connect:
- WhatsApp automation tool for businesses
- Helps businesses automate customer replies, send bulk messages, manage leads
- Affordable alternative to Gallabox and DoubleTick
- Ideal for small and medium businesses

STRICT RULES:
- Your name is Afi
- Always refer to the brand as "GoGadAFI"
- ONLY answer questions related to GoGadAFI business and services
- If asked anything unrelated, reply: "Sorry, I don't have knowledge about it. I'm exclusively created for GoGadAFI 😊"
- Reply in the same language the customer uses
- Keep replies short, friendly, and clear
- Use emojis to keep the tone warm and professional`,
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

// ---------- Detect recruitment intent ----------
function isRecruitmentMessage(text) {
  const keywords = [
    'join', 'intern', 'internship', 'work with you', 'career', 'job',
    'vacancy', 'hiring', 'apply', 'opportunity', 'opening', 'position',
    'சேர', 'வேலை', 'இணைய', 'வாய்ப்பு'
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ---------- Detect greeting ----------
function isGreeting(text) {
  const greetings = ['hi', 'hello', 'hey', 'hlo', 'hii', 'hai', 'vanakkam', 'வணக்கம்', 'namaste'];
  const lower = text.trim().toLowerCase();
  return greetings.some(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + '!'));
}

function buildSystemPrompt(bot, kb, customerName, isFirstTime) {
  let prompt = bot.systemPrompt || '';

  if (kb) {
    let kbSection = '\n\n===== KNOWLEDGE BASE =====';
    kbSection += '\nUse ONLY the information below when answering questions. Do NOT invent details.';
    if (kb.products?.length) {
      kbSection += '\n\nSERVICES/PRODUCTS:';
      kb.products.forEach(p => {
        kbSection += `\n- ${p.name}`;
        if (p.description) kbSection += `: ${p.description}`;
        if (p.price) kbSection += ` | Price: ₹${p.price}`;
      });
    }
    if (kb.faqs?.length) {
      kbSection += '\n\nFAQs:';
      kb.faqs.forEach(f => { kbSection += `\nQ: ${f.q}\nA: ${f.a}`; });
    }
    if (kb.support) kbSection += `\n\nSUPPORT INFO:\n${kb.support}`;
    kbSection += '\n===== END OF KNOWLEDGE BASE =====';
    prompt += kbSection;
  }

  prompt += `\n\nCONTEXT RULES:
- Remember previous messages and answer in context
- For out-of-scope questions, politely redirect to GoGadAFI services`;

  if (isFirstTime) {
    prompt += `\n\n- This is the customer's first message. Start with:\n"Hi ${customerName}! 👋 Welcome to GoGadAFI! I'm Afi, your digital assistant. We help businesses grow with WhatsApp automation & digital marketing. How can I help you today? 😊"`;
  } else {
    prompt += `\n\n- Returning customer. Do NOT send welcome message. Just answer directly.`;
  }

  return prompt;
}

// ---------- Auth: session token verification ----------
// authCheck now verifies OUR OWN session JWT (issued in /api/login after
// Firebase verifies the user). It attaches req.user = { uid, email, role, plan }.
function authCheck(req, res, next) {
  const token = req.headers['x-dashboard-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, SESSION_SECRET_VALUE);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// Optional stricter guard for admin-only routes later
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ---------- /api/login ----------
// The login page (login.html) signs the user in with Firebase (Email/Password
// or Google), then sends us the resulting Firebase ID token. We verify that
// token server-side, upsert the user in MongoDB with a role, and hand back
// our own short-lived session token for use on all other /api/* routes.
app.post('/api/login', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = (decoded.email || '').toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'This account has no email on file.' });
    }

    const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'client';

    if (!usersCol) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    // Upsert the user. New clients get plan: 'starter' by default —
    // change this manually in MongoDB (or build an admin UI) to upgrade them.
    const displayName = decoded.name || email.split('@')[0];

    const existing = await usersCol.findOne({ uid });
    if (!existing) {
      await usersCol.insertOne({
        uid,
        email,
        role,
        plan: role === 'admin' ? 'business' : 'starter',
        name: displayName,
        createdAt: new Date(),
        lastLogin: new Date()
      });
    } else {
      await usersCol.updateOne({ uid }, { $set: { lastLogin: new Date(), role } });
    }

    const user = await usersCol.findOne({ uid });

    const sessionToken = jwt.sign(
      { uid, email, role: user.role, plan: user.plan },
      SESSION_SECRET_VALUE,
      { expiresIn: '7d' }
    );

    res.json({ token: sessionToken, role: user.role, plan: user.plan, email, name: user.name || '' });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(401).json({ error: 'Invalid or expired sign-in. Please try again.' });
  }
});

app.get('/api/conversations', authCheck, async (req, res) => {
  if (!messagesCol) return res.json([]);
  try {
    const conversations = await messagesCol.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$customerPhone', customerName: { $first: '$customerName' }, lastMessage: { $first: '$text' }, lastDirection: { $first: '$direction' }, lastTime: { $first: '$timestamp' }, totalMessages: { $sum: 1 } } },
      { $addFields: { unread: { $cond: [{ $eq: ['$lastDirection', 'incoming'] }, 1, 0] } } },
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
    const messages = await messagesCol.find({ customerPhone: req.params.phone }).sort({ timestamp: 1 }).toArray();
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/send', authCheck, async (req, res) => {
  const { phone, message, customerName } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    await saveMessage({ customerPhone: phone, customerName: customerName || 'Unknown', text: message, direction: 'outgoing', messageId: null });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-template', authCheck, async (req, res) => {
  const { phone, customerName, referredBy } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const waRes = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: 'intern_recruiting', language: { code: 'en' }, components: [{ type: 'header', parameters: [{ type: 'text', text: customerName || 'there' }] }, { type: 'body', parameters: [{ type: 'text', text: referredBy || 'our team' }] }] } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const waMessageId = waRes.data?.messages?.[0]?.id || null;
    await saveMessage({ customerPhone: phone, customerName: customerName || 'Unknown', text: `[Template: intern_recruiting]`, direction: 'outgoing', messageId: waMessageId, status: 'sent' });
    res.json({ success: true });
  } catch (err) {
    console.error('Template send error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

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
    const result = await botsCol.insertOne({ name, model: model || 'llama-3.1-8b-instant', description: description || '', systemPrompt, isDefault: isDefault || false, active: true, contextMessages: contextMessages || 10, messageWaitTime: messageWaitTime || 0, createdAt: new Date() });
    res.json({ success: true, id: result.insertedId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bots/:id', authCheck, async (req, res) => {
  if (!botsCol) return res.status(500).json({ error: 'DB not connected' });
  try {
    const { name, model, description, systemPrompt, isDefault, active, contextMessages, messageWaitTime } = req.body;
    if (isDefault) await botsCol.updateMany({}, { $set: { isDefault: false } });
    await botsCol.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { name, model, description, systemPrompt, isDefault, active, contextMessages, messageWaitTime, updatedAt: new Date() } });
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
    await customersCol.updateOne({ customerPhone: req.params.phone }, { $set: { assignedBotId: botId || null } }, { upsert: true });
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
    await kbCol.updateOne({ botId: req.params.botId }, { $set: { botId: req.params.botId, products: products || [], policies: policies || {}, faqs: faqs || [], support: support || '', updatedAt: new Date() } }, { upsert: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
const pendingReplies = new Map();

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const status = changes?.value?.statuses?.[0];
    if (status && status.status === 'failed') {
      console.error('❌ META BLOCKED DELIVERY:', JSON.stringify(status.errors, null, 2));
      return res.sendStatus(200);
    }
    const message = changes?.value?.messages?.[0];
    if (!message || message.type !== 'text') return res.sendStatus(200);

    const messageId = message.id;
    if (processedMessages.has(messageId)) return res.sendStatus(200);
    processedMessages.add(messageId);
    if (processedMessages.size > 100) processedMessages.clear();

    const customerMessage = message.text.body;
    const customerPhone = message.from;
    const customerName = changes?.value?.contacts?.[0]?.profile?.name || 'there';

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
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

async function sendWhatsApp(phone, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function processAndReply(customerPhone, customerName, bot) {
  try {
    const latestMsgs = await messagesCol
      .find({ customerPhone, direction: 'incoming' })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    if (!latestMsgs.length) return;
    const latestMessage = latestMsgs[0].text;

    // --- RECRUITMENT DETECTION ---
    if (isRecruitmentMessage(latestMessage)) {
      const recruitReply = `We're looking for talented interns! 🚀\n\nInterested in joining GoGadAFI? Please share your details here:\n👉 https://gogadafi.in/recruit\n\nWe'd love to have you on our team! 😊`;
      await saveMessage({ customerPhone, customerName, text: recruitReply, direction: 'outgoing' });
      await sendWhatsApp(customerPhone, recruitReply);
      return;
    }

    // --- GREETING DETECTION ---
    if (isGreeting(latestMessage)) {
      const isFirst = !(await customersCol?.findOne({ customerPhone, firstSeen: { $exists: true } }));
      const greetReply = isFirst
        ? `Hi ${customerName}! 👋 Welcome to GoGadAFI! I'm Afi, your digital assistant. We help businesses grow with WhatsApp automation & digital marketing. How can I help you today? 😊`
        : `Hey ${customerName}! 👋 How can I help you today?`;
      await saveMessage({ customerPhone, customerName, text: greetReply, direction: 'outgoing' });
      await sendWhatsApp(customerPhone, greetReply);
      return;
    }

    const isFirstTime = !(await customersCol?.findOne({ customerPhone, firstSeen: { $exists: true } }));
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
        temperature: 0.3,
        max_tokens: 200
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const reply = groqResponse.data.choices[0].message.content;
    await saveMessage({ customerPhone, customerName, text: reply, direction: 'outgoing' });
    await sendWhatsApp(customerPhone, reply);
  } catch (err) {
    console.error('processAndReply error:', err.response?.data || err.message);
  }
}

function buildFallbackPrompt(customerName, isFirstTime) {
  return `You are Afi, GoGadAFI's WhatsApp assistant.
ABOUT GoGadAFI:
- Brand Name: GoGadAFI
- Founder: Neelakandan
- Type: Digital Marketing Agency & WhatsApp API Provider
- Location: Trichy, Tamil Nadu, India
- Website: https://gogadafi.in
- WhatsApp: +91 93849 26539
- Email: gogadafiofficial@gmail.com
SERVICES: Social Media Marketing, Meta Ads, Google Ads, SEO, Website Design, WhatsApp API Automation
MAIN PRODUCT: AFI Connect — WhatsApp automation tool, affordable alternative to Gallabox & DoubleTick
RULES:
- Name: Afi
- ONLY GoGadAFI topics
- Reply in customer's language
- Short friendly replies with emojis
${isFirstTime ? `- Start with: "Hi ${customerName}! 👋 Welcome to GoGadAFI! I'm Afi, your digital assistant. We help businesses grow with WhatsApp automation & digital marketing. How can I help you today? 😊"` : '- Returning customer, no welcome message, answer directly'}`;
}
// ========== NEW MULTI-TENANT AUTH ROUTES ==========

// Signup - new clients register here
app.post('/api/signup', async (req, res) => {
  const { name, businessName, email, phone, password } = req.body;
  if (!name || !email || !password || !businessName) {
    return res.status(400).json({ message: 'All fields are required' });
  }
  if (!usersCol) return res.status(500).json({ message: 'Database not connected' });
  try {
    const existing = await usersCol.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ message: 'Email already registered' });
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = new ObjectId();
    await usersCol.insertOne({
      _id: userId,
      name,
      businessName,
      email: email.toLowerCase(),
      phone,
      passwordHash,
      role: 'client',
      plan: 'free',
      status: 'active',
      channels: { whatsapp: null, instagram: null, messenger: null },
      createdAt: new Date(),
      lastLogin: new Date()
    });
    res.json({ message: 'Account created successfully' });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ message: 'Signup failed. Try again.' });
  }
});

// Login - works for React frontend with email/password
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
  if (!usersCol) return res.status(500).json({ message: 'Database not connected' });
  try {
    const user = await usersCol.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    if (!user.passwordHash) return res.status(401).json({ message: 'Please use Google Sign-in for this account' });
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: 'Invalid email or password' });
    await usersCol.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
    const JWT_SECRET = process.env.JWT_SECRET || SESSION_SECRET_VALUE;
    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role, plan: user.plan, name: user.name, businessName: user.businessName },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        businessName: user.businessName,
        email: user.email,
        plan: user.plan,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Auth login error:', err.message);
    res.status(500).json({ message: 'Login failed. Try again.' });
  }
});

// Get current user profile
app.get('/api/me', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const JWT_SECRET = process.env.JWT_SECRET || SESSION_SECRET_VALUE;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await usersCol.findOne({ _id: new ObjectId(payload.userId) });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({
      id: user._id.toString(),
      name: user.name,
      businessName: user.businessName,
      email: user.email,
      plan: user.plan,
      role: user.role,
      channels: user.channels || {}
    });
  } catch (err) {
    res.status(401).json({ message: 'Session expired. Please login again.' });
  }
});
// ========== END NEW ROUTES ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
