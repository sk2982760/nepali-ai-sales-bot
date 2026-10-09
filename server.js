require('dotenv').config();
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Ensure process.env.SUPABASE_KEY matches your Render environment variable name
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL is missing from environment variables.');
}

if (!SUPABASE_ANON_KEY) {
  throw new Error('SUPABASE_KEY / SUPABASE_ANON_KEY is missing from environment variables.');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing from environment variables.');
}

// 1. Auth client configured specifically for Node.js (disables browser storage)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

// 2. Admin client for database operations (bypasses RLS)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const BUILD_ID = 'WA-ESU-V17-EMBEDDED-SDK-SESSION-FIX';
const app = express();
app.use(express.json());
app.use(cookieParser());

// Serve static files (e.g. index.html, dashboard.html, signup.html, login.html)
app.use(express.static(__dirname));

// Serve Auth Pages
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve Dashboard (With Session / Cookie Protection Check)
app.get('/dashboard', (req, res) => {
  const storeId = req.query.store_id || req.cookies?.store_id;

  // Allow access if store_id exists in query parameter or browser cookies
  if (!storeId) {
    return res.redirect('/login');
  }

  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Serve Reset Password Page
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'reset-password.html'));
});

// Deduplication cache to prevent Meta double-webhook executions
const processedMessageIds = new Set();

function trackProcessedMessageId(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;

  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }
  return false;
}

// Initialize Groq Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Clean AI output by stripping internal reasoning steps and tags
 */
function cleanAiResponse(text) {
  if (!text) return '';
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/^["']|["']$/g, '');

  if (cleaned.length > 1900) {
    cleaned = cleaned.substring(0, 1900) + '...';
  }
  return cleaned;
}

/* ==========================================================================
   SUPABASE AUTHENTICATION ENDPOINTS
   ========================================================================== */

app.post('/api/signup', async (req, res) => {
  const { storeName, email, password } = req.body;

  if (!storeName || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const { data: existingStore } = await supabase
      .from('stores')
      .select('id')
      .eq('email', email)
      .single();

    if (existingStore) {
      return res.status(400).json({ error: 'Email is already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const { data: store, error } = await supabase
      .from('stores')
      .insert([{ store_name: storeName, email, password: hashedPassword }])
      .select()
      .single();

    if (error || !store) {
      throw error || new Error('Failed to create store account.');
    }

    // Set HTTP-only session cookie
    res.cookie('store_id', store.id, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      store_id: store.id,
      store: store
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    console.log("=== LOGIN REQUEST RECEIVED ===");
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPassword = String(password).trim();

    // Fetch store
    const { data: store, error: storeError } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (storeError || !store) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

    // Direct password match check (supports both bcrypt and plaintext fallbacks)
    let isMatch = false;
    if (store.password && store.password.startsWith('$2a$')) {
      isMatch = await bcrypt.compare(cleanPassword, store.password);
    } else {
      isMatch = (cleanPassword === store.password);
    }

    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

    res.cookie('store_id', store.id, { 
      maxAge: 24 * 60 * 60 * 1000, 
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });

    return res.json({
      success: true,
      storeId: store.id,
      storeName: store.store_name,
      email: store.email
    });

  } catch (err) {
    console.error("Login Crash:", err);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

app.post('/api/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://nepali-ai-sales-bot.onrender.com/reset-password',
    });

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/update-password', async (req, res) => {
  try {
    const { accessToken, newPassword } = req.body;

    if (!accessToken || !newPassword) {
      return res.status(400).json({ success: false, error: 'Missing token or password.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return res.status(401).json({ success: false, error: 'Link expired or invalid. Please request a new one.' });
    }

    const userId = userData.user.id;
    const userEmail = userData.user.email;

    const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: newPassword
    });

    if (updateAuthError) throw updateAuthError;

    await supabase
      .from('stores')
      .update({ updated_at: new Date() })
      .eq('email', userEmail);

    return res.json({ success: true });

  } catch (err) {
    console.error("Reset Password Server Error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   MULTI-TENANT DYNAMIC STORE & DATABASE LOOKUPS
   ========================================================================== */

async function getStoreByPlatformId({ whatsappPhoneId, facebookPageId, instagramAccountId }) {
  const targetId = String(
    whatsappPhoneId || facebookPageId || instagramAccountId || ''
  ).trim();

  if (!targetId) return null;

  try {
    const { data: channel, error: channelErr } = await supabaseAdmin
      .from('store_channels')
      .select('*, stores(*)')
      .eq('channel_id', targetId)
      .maybeSingle();

    if (!channelErr && channel) {
      const storeData = Array.isArray(channel.stores)
        ? channel.stores[0]
        : channel.stores;

      if (storeData) {
        const result = {
          ...storeData,
          active_channel_id: channel.channel_id,
          active_channel_type: channel.channel_type
        };

        if (channel.channel_type === 'whatsapp') {
          result.whatsapp_access_token =
            channel.access_token ||
            storeData.whatsapp_access_token;
        } else {
          result.facebook_page_access_token =
            channel.access_token ||
            storeData.facebook_page_access_token;
        }

        return result;
      }
    }

    let query = supabaseAdmin.from('stores').select('*');

    if (whatsappPhoneId) {
      query = query.eq(
        'whatsapp_phone_number_id',
        String(whatsappPhoneId).trim()
      );
    } else if (facebookPageId) {
      query = query.eq(
        'facebook_page_id',
        String(facebookPageId).trim()
      );
    } else if (instagramAccountId) {
      query = query.eq(
        'instagram_account_id',
        String(instagramAccountId).trim()
      );
    }

    const { data: directStore, error: directErr } =
      await query.maybeSingle();

    if (!directErr && directStore) {
      return directStore;
    }

    console.error(
      `⚠️ Store not found for incoming ID: ${targetId}`
    );

    return null;
  } catch (err) {
    console.error(
      '❌ Error during store lookup:',
      err.message
    );

    return null;
  }
}

async function getStoreInventory(storeId) {
  const { data, error } = await supabase
    .from('products')
    .select('id, title, name, price_npr, price, stock_quantity, description')
    .eq('store_id', storeId);

  if (error) {
    console.error(`Error fetching products for store ${storeId}:`, error);
    return 'No product data available.';
  }

  if (!data || data.length === 0) {
    return 'Currently no items available in catalog.';
  }

  return data
    .map(p => {
      const title = p.name || p.title || 'Product';
      const price = p.price !== undefined ? p.price : (p.price_npr || 0);
      const stock = p.stock_quantity !== undefined ? p.stock_quantity : 0;
      const desc = p.description ? ` (${p.description})` : '';
      return `- ${title}: NPR ${price} | Stock: ${stock}${desc} [ID: ${p.id}]`;
    })
    .join('\n');
}

async function saveChatMessage(storeId, senderPsid, role, content, requiresFollowup = false) {
  try {
    const { error } = await supabase.from('chat_messages').insert([
      { 
        store_id: storeId, 
        sender_psid: senderPsid, 
        role, 
        content,
        requires_followup: requiresFollowup,
        last_activity_at: new Date().toISOString()
      }
    ]);
    if (error) console.error('Error saving chat message:', error);
  } catch (err) {
    console.error('Error in saveChatMessage:', err);
  }
}

async function getChatHistory(storeId, senderPsid, limit = 8) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('store_id', storeId)
    .eq('sender_psid', senderPsid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  
  // Maps non-standard roles to 'assistant' so Groq API doesn't crash
  return data.reverse().map(msg => ({
    role: (msg.role === 'agent' || msg.role === 'system') ? 'assistant' : msg.role,
    content: msg.content
  }));
}

async function saveOrder({ store_id, customer_name, phone_number, delivery_location, product_title, quantity, total_price_npr, delivery_charge_npr }) {
  const orderQuantity = quantity || 1;

  if (!customer_name || customer_name.toLowerCase().includes('unknown') || !phone_number || phone_number.toLowerCase().includes('unknown')) {
    return { success: false, error: 'Incomplete user details provided.' };
  }

  // Use supabaseAdmin to bypass RLS policies
  const { data: orderData, error: orderError } = await supabaseAdmin
    .from('orders')
    .insert([
      {
        store_id,
        customer_name,
        phone_number,
        delivery_location,
        product_title,
        quantity: orderQuantity,
        total_price_npr,
        delivery_charge_npr,
        status: 'unconfirmed'
      }
    ])
    .select();

  if (orderError) {
    console.error(`Error saving order for store ${store_id}:`, orderError);
    return { success: false, error: orderError.message };
  }

  const { data: prodData } = await supabaseAdmin
    .from('products')
    .select('id, stock_quantity')
    .eq('store_id', store_id)
    .ilike('title', `%${product_title}%`)
    .maybeSingle();

  if (prodData) {
    const newStock = Math.max(0, prodData.stock_quantity - orderQuantity);
    await supabaseAdmin
      .from('products')
      .update({ stock_quantity: newStock })
      .eq('id', prodData.id);
  }

  return { success: true, order: orderData[0] };
}

const orderTool = {
  type: 'function',
  function: {
    name: 'saveOrder',
    description: 'Save an order ONLY when the customer specifically asks to place/confirm the order in their CURRENT message AND provides complete details (Name, Phone Number, Delivery Address).',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Full name of the customer provided in chat' },
        phone_number: { type: 'string', description: 'Phone number of the customer provided in chat' },
        delivery_location: { type: 'string', description: 'Delivery address or city provided in chat' },
        product_title: { type: 'string', description: 'Exact product title ordered' },
        quantity: { type: 'integer', description: 'Quantity ordered (default 1)' },
        total_price_npr: { type: 'number', description: 'Total item cost in NPR' },
        delivery_charge_npr: { type: 'number', description: 'Delivery fee in NPR (100 for Inside Valley, 200 for Outside Valley)' }
      },
      required: ['customer_name', 'phone_number', 'delivery_location', 'product_title', 'total_price_npr', 'delivery_charge_npr']
    }
  }
};

/* ==========================================================================
   AI CORE ENGINE (VISION & TEXT)
   ========================================================================== */

async function processCustomerImage(imageUrl, senderPsid, store) {
  const inventoryList = await getStoreInventory(store.id);
  const rawToken = store.whatsapp_access_token || store.facebook_page_access_token || process.env.META_ACCESS_TOKEN || '';
  const token = rawToken.trim();

  try {
    const imageResponse = await fetch(imageUrl, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0',
        'Authorization': `Bearer ${token}` 
      } 
    });
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const visionPrompt = `
You are a polite customer assistant for "${store.store_name}" in Kathmandu speaking natural Romanized Nepali.

Current Available Inventory:
${inventoryList}

RULES:
1. Speak purely in simple, authentic Nepali.
2. NO Hindi words ("aur", "sath", "chahiye", "koi", "pasand").
3. Keep response brief (1-2 sentences).

EXAMPLES:
- In stock: "Hajur, yo design hamro ma uplabdha chha! Price NPR 1200 ho. Order garne ho hajur?"
- Out of stock: "Hajur, yesto exact design ta aile stock ma chhaina."
`;

    const visionResponse = await groq.chat.completions.create({
      model: 'llama-3.2-11b-vision-preview',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPrompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      temperature: 0
    });

    const rawReply = visionResponse.choices[0]?.message?.content || '';
    const aiReply = cleanAiResponse(rawReply) || 'Hajur, photo clear dekhiyana. Kripaya punah photo pathaunu hola.';

    await saveChatMessage(store.id, senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(store.id, senderPsid, 'assistant', aiReply, true);

    return aiReply;
  } catch (err) {
    console.error('Vision API Error:', err);
    return 'Hajur, photo analyze garda kehi samasya aayo. Kripaya text ma lekhera sodhnuhos.';
  }
}

async function processCustomerMessage(userMessage, senderPsid, store) {
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('store_id', store.id);

  let inventoryContext = "No products available in the catalog currently.";
  if (products && products.length > 0) {
    inventoryContext = products.map(p => {
      const title = p.name || p.title || 'Product';
      const price = p.price !== undefined ? p.price : (p.price_npr || 0);
      const stock = p.stock_quantity !== undefined ? p.stock_quantity : 0;
      const desc = p.description ? ` (${p.description})` : '';
      return `- ${title}: NPR ${price} | Stock: ${stock}${desc}`;
    }).join('\n');
  }

  const chatHistory = await getChatHistory(store.id, senderPsid);
  const lowerMsg = userMessage.toLowerCase().trim();

  const { data: pendingOrder } = await supabase
    .from('orders')
    .select('*')
    .eq('store_id', store.id)
    .eq('status', 'unconfirmed')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingOrder && (lowerMsg === 'yes' || lowerMsg === 'confirm' || lowerMsg.includes('ho confirm'))) {
    await supabase
      .from('orders')
      .update({ status: 'confirmed' })
      .eq('id', pendingOrder.id);

    const codConfirmedReply = `Dhanyabad ${pendingOrder.customer_name} hajur! Tapai ko Order (#${pendingOrder.id}) fully CONFIRM bhako chha. Hami chhitai delivery pranti rwanag garnechhaum.`;
    await saveChatMessage(store.id, senderPsid, 'user', userMessage);
    await saveChatMessage(store.id, senderPsid, 'assistant', codConfirmedReply, false);
    return codConfirmedReply;
  }

  const orderDeclinedOrDelayed = lowerMsg.includes('paxi') || 
                                 lowerMsg.includes('pachi') || 
                                 lowerMsg.includes('ahile gardina') || 
                                 lowerMsg.includes('decide garera') || 
                                 lowerMsg.includes('haina pardaina') || 
                                 lowerMsg.includes('pardaina') || 
                                 lowerMsg.includes('nai');

  const isSimpleAck = lowerMsg === 'huss' || lowerMsg === 'okay' || lowerMsg === 'ok' || lowerMsg === 'dhanyabad' || lowerMsg === 'thank you';

  const lastAssistantMsg = [...chatHistory].reverse().find(m => m.role === 'assistant');
  const isOrderAlreadyConfirmed = lastAssistantMsg && (lastAssistantMsg.content.includes('confirm bhayo') || lastAssistantMsg.content.includes('CONFIRM bhako'));

  const shouldDisableTools = isOrderAlreadyConfirmed || orderDeclinedOrDelayed || isSimpleAck;

  const systemPrompt = `You are a polite, natural, and helpful sales assistant for "${store.store_name || 'our shop'}" in Kathmandu, Nepal.

CURRENT LIVE INVENTORY:
${inventoryContext}

STRICT GRAMMAR & LANGUAGE DIRECTIVES:
- Speak strictly in clear, natural Romanized Nepali (Aadarthi Bhasa).
- Maintain short, concise sentences (1-2 sentences maximum).
- FORBIDDEN WORDS/PHRASES: NEVER use "pasand", "pasand aaucha", "koi", "aur", "sath", "chahiye", "karne sakchu", "puchnu".
- MANDATORY PHRASING:
  * Greeting: "Namaste hajur! ${store.store_name || 'our shop'} ma swagat chha."
  * "Do you like this?": "Yo tapai lai mann parchha ki?"
  * "No problem": "Hajur, kehi xaina."
  * "Whenever you decide": "Hajur le decide garepachhi khabar garnuhola hai."

UPSELLING & REJECTION RULES:
1. Refer strictly to the CURRENT LIVE INVENTORY when answering pricing, stock, or product inquiries.
2. If an item is NOT in stock (Stock: 0), state it clearly: "Hajur, [item] ta aile stock ma chhaina."
3. You may suggest a similar item ONCE.
4. CRITICAL: If the customer insists on an out-of-stock item/color or declines an alternative, DO NOT PITCH ANY MORE PRODUCTS!
   - Reply gracefully: "Hajur, bujhe. Stock aune bittikai tapai lai khabar garnechhaum hai! Dhanyabad."

CRITICAL TOOL CALLING INSTRUCTION:
- DO NOT call saveOrder when the user says "Huss", "Paxi garxu", "Decide garera", "Haina pardaina", "Thank you", or asks a general question.
- Call saveOrder ONLY when the customer explicitly provides their Name, Phone Number, and Address with direct intent to place the order now.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const tools = shouldDisableTools ? undefined : [orderTool];

  const response = await groq.chat.completions.create({
    messages,
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    ...(tools && { tools, tool_choice: 'auto' })
  });

  const responseMessage = response.choices[0]?.message;
  await saveChatMessage(store.id, senderPsid, 'user', userMessage);

  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0 && !shouldDisableTools) {
    const toolCall = responseMessage.tool_calls[0];
    if (toolCall.function.name === 'saveOrder') {
      const orderArgs = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;

      orderArgs.store_id = store.id;
      const orderResult = await saveOrder(orderArgs);

      let orderReply = '';
      if (orderResult.success) {
        orderReply = `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order (Order ID: #${orderResult.order.id}) register bhayo. Order final confirm garna kripaya **YES** bhanera reply garnuhola.`;
      } else {
        orderReply = 'Hajur, order confirm garda kehi samasya aayo. Kripaya full name ra phone number punah check garera pathaunu hola.';
      }

      await saveChatMessage(store.id, senderPsid, 'assistant', orderReply, false);
      return orderReply;
    }
  }

  const rawReply = responseMessage.content || '';
  const aiReply = cleanAiResponse(rawReply) || 'Hajur, kehi technical samasya aayo. Kripaya feri prayas garnuhos.';
  
  await saveChatMessage(store.id, senderPsid, 'assistant', aiReply, true);

  return aiReply;
}

/* ==========================================================================
   DYNAMIC OUTBOUND MESSAGING HELPERS
   ========================================================================== */

async function sendTextMessage(senderPsid, responseText, accessToken) {
  try {
    const rawToken = accessToken || process.env.META_ACCESS_TOKEN || '';
    const token = rawToken.trim();

    const res = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderPsid },
        message: { text: responseText }
      })
    });

    const data = await res.json();
    if (data.error) {
      console.error('Meta Send Error:', data.error);
    } else {
      console.log(`✅ Messenger/IG Response sent to user (${senderPsid})`);
    }
  } catch (error) {
    console.error('Failed to send text message:', error);
  }
}

/* ==========================================================================
   WHATSAPP CLOUD API MESSAGING HELPERS
   ========================================================================== */

async function sendWhatsAppTextMessage(
  phoneNumberId,
  recipientWaId,
  responseText,
  accessToken
) {
  if (
    !phoneNumberId ||
    !recipientWaId ||
    !accessToken
  ) {
    console.error(
      '❌ WhatsApp send skipped: missing required credentials.'
    );
    return false;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(recipientWaId),
        type: 'text',
        text: {
          body: String(responseText || '')
        }
      },
      {
        headers: {
          Authorization:
            `Bearer ${String(accessToken).trim()}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const messageId =
      response.data?.messages?.[0]?.id ||
      null;

    console.log(
      `✅ WhatsApp response sent to user (${recipientWaId})` +
      (messageId ? ` | message=${messageId}` : '')
    );

    return true;
  } catch (err) {
    console.error(
      '❌ WhatsApp Send Error:',
      err.response?.data ||
        err.message
    );

    return false;
  }
}

async function getWhatsAppMediaUrl(
  mediaId,
  accessToken
) {
  if (!mediaId || !accessToken) {
    return null;
  }

  try {
    const response = await axios.get(
      `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`,
      {
        params: {
          access_token: String(accessToken).trim()
        }
      }
    );

    return response.data?.url || null;
  } catch (err) {
    console.error(
      '❌ WhatsApp media lookup error:',
      err.response?.data ||
        err.message
    );

    return null;
  }
}

/* ==========================================================================
   FEATURE 2: INSTAGRAM & FACEBOOK COMMENT-TO-DM PRIVATE REPLIES
   ========================================================================== */

async function handleCommentEvent(changeValue, pageOrIgId) {
  try {
    const commentId = changeValue.comment_id || changeValue.id;
    const commentText = changeValue.message || '';
    const senderPsid = changeValue.from?.id;

    if (!commentId || !senderPsid) return;

    const store = await getStoreByPlatformId({ facebookPageId: pageOrIgId, instagramAccountId: pageOrIgId });
    if (!store) return;

    const token = store.facebook_page_access_token || process.env.META_ACCESS_TOKEN || '';

    await axios.post(`https://graph.facebook.com/v20.0/${commentId}/comments`, {
      message: 'Hajur check your DM! Sent you details 😊'
    }, {
      params: { access_token: token }
    });

    const dmReply = await processCustomerMessage(`Customer commented: "${commentText}". Provide price and availability details.`, senderPsid, store);
    
    await axios.post(`https://graph.facebook.com/v20.0/${commentId}/private_replies`, {
      message: dmReply
    }, {
      params: { access_token: token }
    });

    console.log(`💬 Private DM sent for comment ID: ${commentId}`);
  } catch (err) {
    console.error('⚠️ Comment-to-DM Error:', err.response?.data || err.message);
  }
}

/* ==========================================================================
   FEATURE 3: 1-CLICK PATHAO COURIER DISPATCH ENDPOINT
   ========================================================================== */

app.post('/api/orders/:id/dispatch', async (req, res) => {
  try {
    const orderId = req.params.id;

    const { data: order, error } = await supabase
      .from('orders')
      .select('*, stores(*)')
      .eq('id', orderId)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    if (!process.env.PATHAO_ACCESS_TOKEN || !process.env.PATHAO_STORE_ID) {
      return res.status(400).json({
        success: false,
        error: 'Pathao API credentials are missing in process.env.'
      });
    }

    const pathaoResponse = await axios.post(
      `${process.env.PATHAO_BASE_URL || 'https://api-hermes.pathao.com'}/aladdin/api/v1/orders`,
      {
        store_id: process.env.PATHAO_STORE_ID,
        recipient_name: order.customer_name,
        recipient_phone: order.phone_number,
        recipient_address: order.delivery_location,
        amount_to_collect: (order.total_price_npr || 0) + (order.delivery_charge_npr || 0),
        item_type: 2, // Parcel
        delivery_type: 48, // Standard Delivery
        item_quantity: order.quantity || 1,
        item_weight: 0.5
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PATHAO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const trackingId = pathaoResponse.data?.data?.consignment_id || `PTH-${Date.now()}`;

    await supabase
      .from('orders')
      .update({
        status: 'dispatched',
        courier_tracking_id: trackingId,
        dispatch_provider: 'Pathao'
      })
      .eq('id', orderId);

    return res.status(200).json({
      success: true,
      message: 'Order dispatched to Pathao successfully!',
      tracking_id: trackingId
    });

  } catch (err) {
    console.error('❌ Pathao Dispatch Error:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data?.message || 'Failed to dispatch order to Pathao.'
    });
  }
});

/* ==========================================================================
   FEATURE 4: SMART ABANDONED CHAT RECOVERY (BACKGROUND CRON JOB)
   ========================================================================== */

cron.schedule('0 * * * *', async () => {
  console.log('⏰ Running Abandoned Chat Recovery Cron...');

  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    const { data: abandonedChats, error } = await supabase
      .from('chat_messages')
      .select('*, stores(*)')
      .eq('requires_followup', true)
      .lt('last_activity_at', fourHoursAgo);

    if (error || !abandonedChats || abandonedChats.length === 0) return;

    for (const chat of abandonedChats) {
      const store = chat.stores;
      if (!store) continue;

      const followUpMsg = `Namaste hajur! Tapai le asti sodhnubhako item ko stock limited chha. Order book garidim? 😊`;
      const token = store.facebook_page_access_token || process.env.META_ACCESS_TOKEN || '';

      await sendTextMessage(chat.sender_psid, followUpMsg, token);

      await supabase
        .from('chat_messages')
        .update({ requires_followup: false })
        .eq('id', chat.id);
    }
  } catch (cronErr) {
    console.error('❌ Cron Recovery Error:', cronErr);
  }
});

/* ==========================================================================
   STORE ONBOARDING API ROUTES
   ========================================================================== */

async function upsertStore(storePayload) {
  let existingStore = null;

  if (storePayload.facebook_page_id) {
    const { data, error } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('facebook_page_id', String(storePayload.facebook_page_id))
      .maybeSingle();

    if (error) throw error;
    if (data) existingStore = data;
  }

  if (!existingStore && storePayload.whatsapp_phone_number_id) {
    const { data, error } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('whatsapp_phone_number_id', String(storePayload.whatsapp_phone_number_id))
      .maybeSingle();

    if (error) throw error;
    if (data) existingStore = data;
  }

  if (!existingStore && storePayload.instagram_account_id) {
    const { data, error } = await supabaseAdmin
      .from('stores')
      .select('*')
      .eq('instagram_account_id', String(storePayload.instagram_account_id))
      .maybeSingle();

    if (error) throw error;
    if (data) existingStore = data;
  }

  if (existingStore) {
    const { data, error } = await supabaseAdmin
      .from('stores')
      .update(storePayload)
      .eq('id', existingStore.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabaseAdmin
    .from('stores')
    .insert([storePayload])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function saveStoreChannels(storeId, channels) {
  for (const ch of channels) {
    if (!ch.channel_id) continue;

    const channelRow = {
      store_id: String(storeId),
      channel_type: ch.channel_type,
      channel_id: String(ch.channel_id).trim()
    };

    if (ch.access_token) {
      channelRow.access_token = String(ch.access_token).trim();
    }

    const { data: existingChannel, error: lookupError } = await supabaseAdmin
      .from('store_channels')
      .select('id')
      .eq('channel_id', channelRow.channel_id)
      .maybeSingle();

    if (lookupError) {
      throw lookupError;
    }

    if (existingChannel) {
      const { error: updateError } = await supabaseAdmin
        .from('store_channels')
        .update(channelRow)
        .eq('id', existingChannel.id);

      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await supabaseAdmin
        .from('store_channels')
        .insert([channelRow]);

      if (insertError) throw insertError;
    }
  }
}

/* ==========================================================================
   WHATSAPP FLOW COMPATIBILITY ROUTES
   The active onboarding flow is the FB.login JS SDK embedded popup.
   Full-page manual OAuth cannot deliver WA_EMBEDDED_SIGNUP postMessage data.
   ========================================================================== */
app.get('/auth/whatsapp/start', (req, res) => {
  const storeId = String(req.query.store_id || '').trim();
  if (!storeId) return res.status(400).send('Missing store_id.');
  return res.redirect(`/dashboard?store_id=${encodeURIComponent(storeId)}`);
});

app.get('/auth/whatsapp/callback', (req, res) => {
  return res.status(410).send(
    'This legacy WhatsApp OAuth callback is retired. Return to the dashboard, hard-refresh, and use Connect WhatsApp.'
  );
});

/* ==========================================================================
   SOCIAL CHANNEL OAUTH CONNECT ROUTES (FACEBOOK & WHATSAPP)
   ========================================================================== */

const getRedirectUri = (req) => {
  return process.env.FB_REDIRECT_URI || 'https://nepali-ai-sales-bot.onrender.com/auth/facebook/callback';
};

// 1. Initiate Facebook OAuth
app.get('/auth/facebook', (req, res) => {
  const { store_id, store_name } = req.query;

  const appId = process.env.FB_APP_ID || process.env.META_APP_ID;
  const redirectUri = getRedirectUri(req);
  const scopes = [
    'pages_show_list',
    'pages_messaging',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_messages',
    'business_management'
  ].join(',');

  const statePayload = JSON.stringify({
    store_id: store_id || null,
    store_name: store_name || null
  });
  const state = Buffer.from(statePayload).toString('base64url');

  const fbAuthUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;

  res.redirect(fbAuthUrl);
});

// 2. OAuth Callback Handler
app.get('/auth/facebook/callback', async (req, res) => {
  const { code, state } = req.query;

  let targetStoreId = req.cookies?.store_id || null;

  // Recover the original dashboard store ID from OAuth state.
  if (state) {
    try {
      const decodedState = JSON.parse(
        Buffer.from(String(state), 'base64url').toString('utf8')
      );

      if (decodedState.store_id) {
        targetStoreId = decodedState.store_id;
      }
    } catch (err) {
      console.error('Failed to parse Facebook OAuth state:', err);
    }
  }

  if (!targetStoreId || !code) {
    return res.status(400).send(
      'Failed to complete Facebook OAuth: Missing authorization code or Store ID.'
    );
  }

  try {
    const appId = process.env.FB_APP_ID || process.env.META_APP_ID;
    const appSecret = process.env.FB_APP_SECRET || process.env.META_APP_SECRET;
    const redirectUri = getRedirectUri(req);

    if (!appId || !appSecret) {
      throw new Error('Facebook OAuth app credentials are missing.');
    }

    // 1. Exchange authorization code for a user access token.
    const tokenUrl =
      `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      console.error('Facebook Token Exchange Error:', tokenData);
      return res.status(400).send(
        `OAuth Error: ${tokenData.error?.message || 'Token exchange failed.'}`
      );
    }

    const userAccessToken = tokenData.access_token;

    if (!userAccessToken) {
      throw new Error('Facebook did not return a user access token.');
    }

    // 2. Get Facebook Pages connected to this Meta account.
    const pagesUrl =
      `https://graph.facebook.com/v20.0/me/accounts` +
      `?fields=id,name,access_token,instagram_business_account` +
      `&access_token=${encodeURIComponent(userAccessToken)}`;

    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();

    if (!pagesRes.ok || pagesData.error) {
      console.error('Facebook Pages API Error:', pagesData);
      return res.status(400).send(
        pagesData.error?.message || 'Could not retrieve Facebook Pages.'
      );
    }

    const pages = pagesData.data || [];

    if (pages.length === 0) {
      return res.status(400).send(
        'No Facebook Pages found for this Meta account.'
      );
    }

    // 3. Select the first available Facebook Page.
    const primaryPage = pages[0];

    const pageId = String(primaryPage.id || '').trim();
    const pageAccessToken = String(primaryPage.access_token || '').trim() || null;
   let instagramId = primaryPage.instagram_business_account?.id
  ? String(primaryPage.instagram_business_account.id).trim()
  : null;

// Explicitly query the Facebook Page for its linked Instagram account.
try {
  const pageDetailsUrl =
    `https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}` +
    `?fields=id,name,instagram_business_account` +
    `&access_token=${encodeURIComponent(userAccessToken)}`;

  const pageDetailsRes = await fetch(pageDetailsUrl);
  const pageDetails = await pageDetailsRes.json();

  console.log(
    'Facebook Page details:',
    JSON.stringify({
      id: pageDetails.id,
      name: pageDetails.name,
      instagram_business_account: pageDetails.instagram_business_account || null
    }, null, 2)
  );

  if (!pageDetailsRes.ok || pageDetails.error) {
    console.error('Facebook Page details error:', pageDetails);
  } else if (pageDetails.instagram_business_account?.id) {
    instagramId = String(
      pageDetails.instagram_business_account.id
    ).trim();
  }
} catch (igLookupError) {
  console.error(
    'Instagram account lookup failed:',
    igLookupError.message
  );
}

    if (!pageId || !pageAccessToken) {
      throw new Error(
        'Facebook Page information or Page Access Token was not returned by Meta.'
      );
    }

    // 4. Confirm that the store the dashboard was using still exists.
    const { data: targetStore, error: targetStoreError } = await supabaseAdmin
      .from('stores')
      .select('id, store_name')
      .eq('id', targetStoreId)
      .maybeSingle();

    if (targetStoreError) {
      throw targetStoreError;
    }

    if (!targetStore) {
      return res.status(404).send(
        `Store not found for store_id: ${targetStoreId}`
      );
    }

    // 5. Save the Facebook/Instagram connection into the EXISTING store.
    // Uses the same column consumed by the webhook/inbox code.
    const { data: updatedStore, error: dbError } = await supabaseAdmin
      .from('stores')
      .update({
        facebook_page_access_token: pageAccessToken,
        facebook_page_id: pageId,
        instagram_account_id: instagramId,
        facebook_pages: pages
      })
      .eq('id', targetStoreId)
      .select()
      .single();

    if (dbError) {
      console.error('Facebook connection database error:', dbError);
      throw dbError;
    }

    if (!updatedStore) {
      throw new Error(
        `No store was updated for store_id: ${targetStoreId}`
      );
    }

    // 6. Persist channel rows for Messenger and Instagram.
    const channels = [
      {
        channel_type: 'messenger',
        channel_id: pageId,
        access_token: pageAccessToken
      }
    ];

    if (instagramId) {
      channels.push({
        channel_type: 'instagram',
        channel_id: instagramId,
        access_token: pageAccessToken
      });
    }

    await saveStoreChannels(targetStoreId, channels);

    // 7. Keep the correct store in the browser session.
    res.cookie('store_id', String(targetStoreId), {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    console.log('======================================');
    console.log('✅ FACEBOOK / INSTAGRAM CONNECTED');
    console.log('Store ID:', targetStoreId);
    console.log('Facebook Page ID:', pageId);
    console.log('Instagram Account ID:', instagramId || 'None');
    console.log('Page access token saved:', Boolean(pageAccessToken));
    console.log('======================================');

    return res.redirect(
      `/dashboard?store_id=${encodeURIComponent(targetStoreId)}&oauth=success`
    );

  } catch (err) {
    console.error(
      '❌ Meta OAuth Handler Error:',
      err.response?.data || err.message || err
    );

    return res.status(500).send(
      `Failed to connect Facebook & Instagram: ${err.response?.data?.error?.message || err.message || 'Unknown error'}`
    );
  }
});

/* ==========================================================================
   WHATSAPP CLOUD API EMBEDDED SIGNUP
   ========================================================================== */

const WHATSAPP_GRAPH_VERSION =
  process.env.WHATSAPP_GRAPH_VERSION ||
  process.env.META_GRAPH_VERSION ||
  'v25.0';

const WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID =
  process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID ||
  process.env.META_WHATSAPP_CONFIG_ID ||
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID ||
  process.env.WHATSAPP_CONFIG_ID ||
  process.env.META_CONFIG_ID ||
  '';

const META_APP_ID =
  process.env.META_APP_ID ||
  process.env.FB_APP_ID ||
  '';

const META_APP_SECRET =
  process.env.META_APP_SECRET ||
  process.env.FB_APP_SECRET ||
  '';

// Facebook JS SDK Embedded Signup uses the clean dashboard URL as its OAuth context.
// dashboard.html removes the store_id query before FB.login; keep this exact URI
// registered under Facebook Login for Business > Valid OAuth Redirect URIs.
const WHATSAPP_JS_SDK_REDIRECT_URI =
  'https://nepali-ai-sales-bot.onrender.com/dashboard';


/**
 * Public configuration endpoint for dashboard.html.
 * Never return the Meta App Secret to the browser.
 */
app.get('/api/whatsapp/embedded-signup-config', (req, res) => {
  if (!META_APP_ID) {
    return res.status(500).json({
      success: false,
      error: 'META_APP_ID is not configured on the server.'
    });
  }

  if (!WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID) {
    return res.status(500).json({
      success: false,
      error:
        'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID is not configured on the server.'
    });
  }

  return res.json({
    success: true,
    app_id: META_APP_ID,
    config_id: WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID
  });
});


app.get('/api/whatsapp/debug', (req, res) => {
  return res.json({
    success: true,
    build_id: BUILD_ID,
    whatsapp_graph_version: WHATSAPP_GRAPH_VERSION,
    config_id: WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || null,
    token_exchange: 'POST /oauth/access_token with client_id, client_secret, code, grant_type, redirect_uri',
    redirect_uri_used_by_whatsapp_exchange: WHATSAPP_JS_SDK_REDIRECT_URI,
    launch_mode: 'Facebook JavaScript SDK FB.login Embedded Signup with WA_EMBEDDED_SIGNUP session events'
  });
});

/**
 * Discover WABA IDs from the business token when the browser session event
 * did not arrive before the FB.login callback.
 */
async function discoverWabaIdsFromBusinessToken(businessToken) {
  if (!businessToken || !META_APP_ID || !META_APP_SECRET) {
    return [];
  }

  try {
    const response = await axios.get(
      `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/debug_token`,
      {
        params: {
          input_token: businessToken,
          access_token: `${META_APP_ID}|${META_APP_SECRET}`
        }
      }
    );

    const debugData = response.data?.data;

    if (!debugData?.is_valid) {
      console.error(
        '⚠️ WhatsApp business token is invalid according to debug_token.'
      );
      return [];
    }

    const ids = new Set();

    for (const item of debugData.granular_scopes || []) {
      const scope = item?.scope || '';

      if (
        scope === 'whatsapp_business_management' ||
        scope === 'whatsapp_business_messaging'
      ) {
        for (const id of item?.target_ids || []) {
          if (id) ids.add(String(id));
        }
      }
    }

    // Fallback for Meta responses where the granular scope naming differs
    // but explicit target_ids are still present.
    if (ids.size === 0) {
      for (const item of debugData.granular_scopes || []) {
        for (const id of item?.target_ids || []) {
          if (id) ids.add(String(id));
        }
      }
    }

    return [...ids];
  } catch (err) {
    console.error(
      '❌ WhatsApp debug_token error:',
      err.response?.data || err.message
    );

    return [];
  }
}

/**
 * Get phone numbers associated with a customer's WABA.
 */
async function getWhatsAppPhoneNumbers(wabaId, businessToken) {
  if (!wabaId || !businessToken) return [];

  const response = await axios.get(
    `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/phone_numbers`,
    {
      params: {
        access_token: businessToken
      }
    }
  );

  return response.data?.data || [];
}

/**
 * Subscribe the Meta app to the customer's WABA so WhatsApp webhooks are
 * sent to the app's configured webhook endpoint.
 */
async function subscribeAppToWhatsAppWaba(
  wabaId,
  businessToken
) {
  if (!wabaId || !businessToken) {
    throw new Error(
      'WABA ID and business token are required for webhook subscription.'
    );
  }

  const response = await axios.post(
    `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/subscribed_apps`,
    {},
    {
      params: {
        access_token: businessToken
      }
    }
  );

  return response.data;
}

/**
 * Optional phone registration.
 *
 * To enable this, add WHATSAPP_REGISTRATION_PIN=123456 to Render.
 * Meta requires a 6-digit PIN when registering a phone for Cloud API.
 */
async function registerWhatsAppPhoneIfConfigured(
  phoneNumberId,
  businessToken
) {
  const pin = String(
    process.env.WHATSAPP_REGISTRATION_PIN || ''
  ).trim();

  if (!pin) {
    return {
      attempted: false,
      skipped: true
    };
  }

  if (!/^\d{6}$/.test(pin)) {
    throw new Error(
      'WHATSAPP_REGISTRATION_PIN must contain exactly 6 digits.'
    );
  }

  const response = await axios.post(
    `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/register`,
    {
      messaging_product: 'whatsapp',
      pin
    },
    {
      headers: {
        Authorization: `Bearer ${businessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return {
    attempted: true,
    skipped: false,
    result: response.data
  };
}

/**
 * Complete WhatsApp Embedded Signup.
 *
 * The browser posts the short-lived Embedded Signup authorization code.
 * This server exchanges it for the customer's Business Integration System
 * User token, resolves the WABA and phone number, subscribes the WABA to
 * webhooks, and stores the credentials against the EXISTING store.
 */
app.post('/api/whatsapp/embedded-signup', async (req, res) => {
  const {
    store_id,
    code,
    access_token,
    waba_id,
    phone_number_id,
    signup_event,
    signup_event_data
  } = req.body || {};

  if (!store_id) {
    return res.status(400).json({
      success: false,
      error: 'Missing store_id.'
    });
  }

  if (!code && !access_token) {
    return res.status(400).json({
      success: false,
      error:
        'Meta did not return an authorization code or access token.'
    });
  }

  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(500).json({
      success: false,
      error:
        'META_APP_ID or META_APP_SECRET is missing from the server.'
    });
  }

  try {
    // Never create a new store during WhatsApp onboarding.
    const { data: targetStore, error: targetStoreError } =
      await supabaseAdmin
        .from('stores')
        .select('id, store_name')
        .eq('id', String(store_id))
        .maybeSingle();

    if (targetStoreError) {
      throw targetStoreError;
    }

    if (!targetStore) {
      return res.status(404).json({
        success: false,
        error: `Store not found for store_id: ${store_id}`
      });
    }

    let businessToken = null;

    if (access_token) {
      businessToken = String(access_token).trim();
    } else if (code) {
      console.log(
        '🔐 Exchanging WhatsApp Embedded Signup authorization code server-side...'
      );

      const tokenEndpoint =
        `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/oauth/access_token`;

      // Keep this URI identical to the clean URL from which FB.login was launched.
      // The dashboard saves store_id to cookie/localStorage, then changes the URL
      // to /dashboard before opening the Meta JS SDK dialog.
      const tokenParams = {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: WHATSAPP_JS_SDK_REDIRECT_URI
      };

      console.log('🔐 WhatsApp token exchange request:', {
        method: 'POST',
        redirect_uri: WHATSAPP_JS_SDK_REDIRECT_URI,
        has_code: Boolean(code)
      });

      const response = await axios.post(
        tokenEndpoint,
        new URLSearchParams(tokenParams).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true
        }
      );

      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.data?.error
      ) {
        console.error(
          '❌ WhatsApp authorization-code exchange failed:',
          response.data
        );

        throw new Error(
          response.data?.error?.message ||
            `Meta token exchange failed with HTTP ${response.status}.`
        );
      }

      businessToken = response.data?.access_token || null;

      if (!businessToken) {
        throw new Error(
          'Meta authorization-code exchange succeeded but no access token was returned.'
        );
      }

      console.log(
        '✅ WhatsApp authorization code exchanged successfully.'
      );
    } else {
      throw new Error(
        'Meta did not return an authorization code or access token.'
      );
    }

    if (!businessToken) {
      throw new Error(
        'Unable to obtain a WhatsApp business access token.'
      );
    }

    const normalizeId = (value) => {
      if (!value) return null;
      if (typeof value === 'object') {
        return String(value.id || value.waba_id || value.phone_number_id || '').trim() || null;
      }
      return String(value).trim() || null;
    };

    let resolvedWabaId =
      normalizeId(waba_id) ||
      normalizeId(signup_event_data?.waba_id) ||
      normalizeId(signup_event_data?.waba_ids?.[0]) ||
      normalizeId(signup_event_data?.waba?.id) ||
      null;

    let resolvedPhoneNumberId =
      normalizeId(phone_number_id) ||
      normalizeId(signup_event_data?.phone_number_id) ||
      normalizeId(signup_event_data?.phone?.id) ||
      null;

    console.log('📱 WhatsApp signup inputs:', {
      signup_event: signup_event || null,
      waba_id_received: Boolean(resolvedWabaId),
      phone_number_id_received: Boolean(resolvedPhoneNumberId),
      has_code: Boolean(code),
      has_access_token: Boolean(access_token)
    });

    // Session logging data can contain multiple WABAs.
    if (
      !resolvedWabaId &&
      Array.isArray(signup_event_data?.waba_ids)
    ) {
      resolvedWabaId =
        signup_event_data.waba_ids[0] || null;
    }

    // The message event and FB.login callback are independent. If the
    // browser did not receive the WABA ID in time, use debug_token.
    if (!resolvedWabaId) {
      // First try Meta's direct WABA lookup for the customer-scoped token.
      try {
        const meWabaResponse = await axios.get(
          `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/me/whatsapp_business_accounts`,
          { params: { access_token: businessToken } }
        );
        const firstWaba = meWabaResponse.data?.data?.[0]?.id || null;
        if (firstWaba) {
          resolvedWabaId = String(firstWaba);
          console.log('✅ WABA discovered from /me/whatsapp_business_accounts.');
        }
      } catch (lookupError) {
        console.warn(
          '⚠️ Direct /me/whatsapp_business_accounts lookup failed:',
          lookupError.response?.data || lookupError.message
        );
      }
    }

    if (!resolvedWabaId) {
      const discoveredWabaIds =
        await discoverWabaIdsFromBusinessToken(
          businessToken
        );

      resolvedWabaId =
        discoveredWabaIds[0] || null;

      if (resolvedWabaId) {
        console.log(
          '✅ WABA discovered from WhatsApp business token.'
        );
      }
    }

    if (!resolvedWabaId) {
      throw new Error(
        `WhatsApp signup completed with event ${signup_event || 'UNKNOWN'}, but no WABA ID was returned. ` +
        'For an existing WhatsApp Business App number, Embedded Signup must be launched with ' +
        'featureType=whatsapp_business_app_onboarding. Check the browser session event and try again.'
      );
    }

    // If phone_number_id did not arrive in session logging, discover it from
    // the WABA. The current dashboard has one connection, so use the first
    // available phone number.
    let phoneNumbers = [];

    try {
      phoneNumbers =
        await getWhatsAppPhoneNumbers(
          resolvedWabaId,
          businessToken
        );
    } catch (phoneError) {
      console.error(
        '⚠️ Unable to list WhatsApp phone numbers:',
        phoneError.response?.data ||
          phoneError.message
      );
    }

    if (!resolvedPhoneNumberId && phoneNumbers.length > 0) {
      resolvedPhoneNumberId =
        phoneNumbers[0]?.id
          ? String(phoneNumbers[0].id).trim()
          : null;
    }

    if (!resolvedPhoneNumberId) {
      throw new Error(
        `WABA ${resolvedWabaId} was found, but no WhatsApp phone number ID was returned. ` +
        'Complete the phone-number portion of Embedded Signup and try again.'
      );
    }

    // Validate provided phone ID against the selected WABA when possible.
    if (phoneNumbers.length > 0) {
      const phoneBelongsToWaba =
        phoneNumbers.some(
          (phone) =>
            String(phone?.id || '').trim() ===
            String(resolvedPhoneNumberId).trim()
        );

      if (!phoneBelongsToWaba) {
        throw new Error(
          'The selected WhatsApp phone number does not belong to the WABA returned by Meta.'
        );
      }
    }

    // Subscribe the app to WABA webhooks.
    let webhookSubscription;

    try {
      webhookSubscription =
        await subscribeAppToWhatsAppWaba(
          resolvedWabaId,
          businessToken
        );

      console.log(
        '✅ WhatsApp WABA webhook subscription completed.'
      );
    } catch (subscribeError) {
      console.error(
        '❌ WhatsApp WABA webhook subscription failed:',
        subscribeError.response?.data ||
          subscribeError.message
      );

      throw new Error(
        `WhatsApp WABA webhook subscription failed: ${
          subscribeError.response?.data?.error?.message ||
          subscribeError.message
        }`
      );
    }

    // Optional phone registration. By default this is skipped so we do not
    // invent a PIN or alter the customer's phone configuration.
    let phoneRegistration = {
      attempted: false,
      skipped: true
    };

    try {
      phoneRegistration =
        await registerWhatsAppPhoneIfConfigured(
          resolvedPhoneNumberId,
          businessToken
        );

      if (phoneRegistration.attempted) {
        console.log(
          '✅ WhatsApp phone registration completed.'
        );
      } else {
        console.log(
          'ℹ️ WhatsApp phone registration skipped; ' +
          'WHATSAPP_REGISTRATION_PIN is not configured.'
        );
      }
    } catch (registrationError) {
      console.error(
        '❌ WhatsApp phone registration failed:',
        registrationError.response?.data ||
          registrationError.message
      );

      throw new Error(
        `WhatsApp phone registration failed: ${
          registrationError.response?.data?.error?.message ||
          registrationError.message
        }`
      );
    }

    // Save the actual usable connection to the current store.
    const { data: updatedStore, error: storeUpdateError } =
      await supabaseAdmin
        .from('stores')
        .update({
          whatsapp_phone_number_id:
            String(resolvedPhoneNumberId).trim(),
          whatsapp_access_token: businessToken
        })
        .eq('id', String(store_id))
        .select()
        .single();

    if (storeUpdateError) {
      throw storeUpdateError;
    }

    if (!updatedStore) {
      throw new Error(
        `No store was updated for store_id: ${store_id}`
      );
    }

    // Store phone-number routing information in the multi-channel table.
    await saveStoreChannels(String(store_id), [
      {
        channel_type: 'whatsapp',
        channel_id:
          String(resolvedPhoneNumberId).trim(),
        access_token: businessToken
      }
    ]);

    // Never return or log the actual business token.
    console.log('======================================');
    console.log('✅ WHATSAPP EMBEDDED SIGNUP COMPLETED');
    console.log('Store ID:', store_id);
    console.log('WABA ID:', resolvedWabaId);
    console.log(
      'Phone Number ID:',
      resolvedPhoneNumberId
    );
    console.log(
      'Signup Event:',
      signup_event || 'not provided'
    );
    console.log(
      'Webhook subscription:',
      webhookSubscription?.success === true
        ? 'success'
        : 'completed'
    );
    console.log(
      'Phone registration:',
      phoneRegistration.attempted
        ? 'completed'
        : 'not attempted'
    );
    console.log('Business token saved: true');
    console.log('======================================');

    return res.status(200).json({
      success: true,
      store_id: String(store_id),
      whatsapp_phone_number_id:
        String(resolvedPhoneNumberId),
      waba_id: String(resolvedWabaId),
      phone_registration_attempted:
        Boolean(phoneRegistration.attempted)
    });

  } catch (err) {
    console.error(
      '❌ WhatsApp Embedded Signup Error:',
      err.response?.data ||
        err.message ||
        err
    );

    return res.status(500).json({
      success: false,
      error:
        err.response?.data?.error?.message ||
        err.message ||
        'Failed to complete WhatsApp Embedded Signup.'
    });
  }
});

/*
 * The old /auth/whatsapp generic OAuth flow has intentionally been removed.
 * WhatsApp onboarding now uses Meta Embedded Signup from dashboard.html.
 */

app.post('/api/connect-all-channels', async (req, res) => {
  try {
    const { store_name, user_access_token, owner_id } = req.body;

    if (!store_name || !user_access_token) {
      return res.status(400).json({ success: false, error: 'Store name and Meta access token are required.' });
    }

    const connectedChannels = [];
    const channelList = [];

    let facebookPageId = null;
    let facebookPageAccessToken = null;
    let instagramAccountId = null;

    try {
      const pageRes = await axios.get('https://graph.facebook.com/v20.0/me/accounts', {
        params: {
          access_token: user_access_token,
          fields: 'id,name,access_token,instagram_business_account'
        }
      });

      const pages = pageRes.data?.data || [];
      if (pages.length > 0) {
        const primaryPage = pages[0];
        facebookPageId = String(primaryPage.id).trim();
        facebookPageAccessToken = primaryPage.access_token;
        connectedChannels.push('Facebook Messenger');

        channelList.push({
          channel_type: 'messenger',
          channel_id: facebookPageId,
          access_token: facebookPageAccessToken
        });

        if (primaryPage.instagram_business_account && primaryPage.instagram_business_account.id) {
          instagramAccountId = String(primaryPage.instagram_business_account.id).trim();
          connectedChannels.push('Instagram DMs');

          channelList.push({
            channel_type: 'instagram',
            channel_id: instagramAccountId,
            access_token: facebookPageAccessToken
          });
        }
      }
    } catch (fbErr) {
      console.error('⚠️ Error fetching Meta Pages:', fbErr.response?.data || fbErr.message);
    }

    if (connectedChannels.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No active Facebook Page or Instagram Account found under this Meta profile.'
      });
    }

    const slug = store_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const storePayload = {
      store_name: store_name.trim(),
      slug: slug,
      facebook_page_id: facebookPageId,
      facebook_page_access_token: facebookPageAccessToken,
      instagram_account_id: instagramAccountId,
      ...(owner_id && { owner_id })
    };

    const createdStore = await upsertStore(storePayload);
    await saveStoreChannels(createdStore.id, channelList);

    res.cookie('store_id', createdStore.id, { 
      maxAge: 24 * 60 * 60 * 1000, 
      httpOnly: false, 
      sameSite: 'lax', 
      secure: process.env.NODE_ENV === 'production' 
    });

    return res.status(200).json({
      success: true,
      connectedChannels,
      store: createdStore
    });

  } catch (err) {
    console.error('❌ Server Error during channel onboarding:', err.message || err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/* ==========================================================================
   SCOPED DASHBOARD & PRODUCT CATALOG DATA API ROUTES
   ========================================================================== */

app.get('/api/dashboard', async (req, res) => {
  try {
    const storeId = req.query.store_id || req.cookies?.store_id;

    let storeQuery = supabase.from('stores').select('*');
    if (storeId) {
      storeQuery = storeQuery.eq('id', storeId);
    }

    const { data: stores, error: storeErr } = await storeQuery.limit(1);

    if (storeErr || !stores || stores.length === 0) {
      return res.json({ store: null, orders: [], products: [] });
    }

    const store = stores[0];

    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('store_id', store.id)
      .order('id', { ascending: false });

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('store_id', store.id);

    return res.json({
      store,
      orders: orders || [],
      products: products || []
    });
  } catch (err) {
    console.error('Dashboard API Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Add product to store catalog
app.post('/api/products', async (req, res) => {
  try {
    const { store_id, name, price, stock_quantity, description } = req.body;

    if (!store_id || !name || price === undefined) {
      return res.status(400).json({ error: 'Missing required product parameters.' });
    }

    const insertPayload = {
      store_id,
      title: name,
      name,
      price_npr: price,
      price,
      stock_quantity: stock_quantity || 0,
      description: description || '',
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('products')
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, product: data });
  } catch (err) {
    console.error('Error adding product:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ==========================================================================
   META MESSENGER & INSTAGRAM WEBHOOK ROUTES
   ========================================================================== */

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  const isPageEvent =
    body.object === 'page' ||
    body.object === 'instagram';

  const isWhatsAppEvent =
    body.object === 'whatsapp_business_account';

  if (!isPageEvent && !isWhatsAppEvent) {
    return res.sendStatus(404);
  }

  // Acknowledge Meta immediately.
  res.status(200).send('EVENT_RECEIVED');

  try {
    // -----------------------------------------------------------------------
    // FACEBOOK / INSTAGRAM
    // -----------------------------------------------------------------------
    if (isPageEvent) {
      for (const entry of body.entry || []) {
        const pageOrIgId = entry.id;

        if (entry.changes) {
          for (const change of entry.changes) {
            if (
              change.field === 'comments' ||
              change.field === 'feed'
            ) {
              await handleCommentEvent(
                change.value,
                pageOrIgId
              );
            }
          }
        }

        const messagingEvents =
          entry.messaging || [];

        for (const messagingEvent of messagingEvents) {
          const senderPsid =
            messagingEvent.sender?.id ||
            messagingEvent.from?.id;

          const messageId =
            messagingEvent.message?.mid ||
            messagingEvent.id;

          if (
            !senderPsid ||
            messagingEvent.message?.is_echo
          ) {
            continue;
          }

          if (trackProcessedMessageId(messageId)) {
            continue;
          }

          const store =
            await getStoreByPlatformId({
              facebookPageId: pageOrIgId,
              instagramAccountId: pageOrIgId
            });

          if (!store) continue;

          const rawToken =
            store.facebook_page_access_token ||
            process.env.META_ACCESS_TOKEN ||
            '';

          if (messagingEvent.message?.attachments) {
            const imgUrl =
              messagingEvent.message
                .attachments[0]
                ?.payload?.url;

            if (imgUrl) {
              const aiReply =
                await processCustomerImage(
                  imgUrl,
                  senderPsid,
                  store
                );

              await sendTextMessage(
                senderPsid,
                aiReply,
                rawToken
              );
            }
          } else if (
            messagingEvent.message?.text
          ) {
            const userMsg =
              messagingEvent.message.text;

            const aiReply =
              await processCustomerMessage(
                userMsg,
                senderPsid,
                store
              );

            await sendTextMessage(
              senderPsid,
              aiReply,
              rawToken
            );
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // WHATSAPP CLOUD API
    // -----------------------------------------------------------------------
    if (isWhatsAppEvent) {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') {
            continue;
          }

          const value = change.value || {};

          const phoneNumberId =
            value.metadata?.phone_number_id;

          if (!phoneNumberId) {
            console.error(
              '⚠️ WhatsApp webhook missing metadata.phone_number_id.'
            );
            continue;
          }

          const store =
            await getStoreByPlatformId({
              whatsappPhoneId: phoneNumberId
            });

          if (!store) {
            console.error(
              `⚠️ No store found for WhatsApp phone number ID: ${phoneNumberId}`
            );
            continue;
          }

          const accessToken =
            store.whatsapp_access_token ||
            process.env.META_ACCESS_TOKEN ||
            '';

          if (!accessToken) {
            console.error(
              `⚠️ No WhatsApp access token found for store ${store.id}.`
            );
            continue;
          }

          for (const message of value.messages || []) {
            const messageId = message.id;
            const senderWaId = message.from;

            if (!senderWaId) continue;

            if (
              trackProcessedMessageId(messageId)
            ) {
              continue;
            }

            let aiReply = null;

            if (
              message.type === 'text' &&
              message.text?.body
            ) {
              aiReply =
                await processCustomerMessage(
                  message.text.body,
                  senderWaId,
                  store
                );
            } else if (
              message.type === 'image' &&
              message.image?.id
            ) {
              const mediaUrl =
                await getWhatsAppMediaUrl(
                  message.image.id,
                  accessToken
                );

              if (mediaUrl) {
                aiReply =
                  await processCustomerImage(
                    mediaUrl,
                    senderWaId,
                    store
                  );
              } else {
                await saveChatMessage(
                  store.id,
                  senderWaId,
                  'user',
                  '[Sent a WhatsApp image]'
                );

                aiReply =
                  'Hajur, photo analyze garna sakiyena. Kripaya photo feri pathaunu hola.';
              }
            }

            if (aiReply) {
              await sendWhatsAppTextMessage(
                phoneNumberId,
                senderWaId,
                aiReply,
                accessToken
              );
            }
          }
        }
      }
    }

  } catch (webhookErr) {
    console.error(
      '❌ Webhook processing error:',
      webhookErr.response?.data ||
        webhookErr.message ||
        webhookErr
    );
  }
});

/* ==========================================================================
   UNIFIED MULTI-CHANNEL INBOX ENDPOINTS (STRICTLY SCOPED)
   ========================================================================== */

app.get('/inbox', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'inbox.html'));
});

app.get('/api/inbox/conversations', async (req, res) => {
  try {
    const { store_id } = req.query;

    if (!store_id || store_id === 'undefined' || store_id === 'null') {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from('chat_messages')
      .select('sender_psid, content, created_at, store_id')
      .eq('store_id', store_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const threads = [];
    const seenPsids = new Set();

    for (const msg of data || []) {
      if (!seenPsids.has(msg.sender_psid)) {
        seenPsids.add(msg.sender_psid);
        threads.push({
          sender_psid: msg.sender_psid,
          last_message: msg.content,
          last_activity_at: msg.created_at
        });
      }
    }

    return res.json(threads);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/inbox/messages', async (req, res) => {
  try {
    const { sender_psid, store_id } = req.query;

    if (!sender_psid) return res.status(400).json({ error: 'sender_psid is required' });
    if (!store_id || store_id === 'undefined' || store_id === 'null') {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from('chat_messages')
      .select('role, content, created_at')
      .eq('sender_psid', sender_psid)
      .eq('store_id', store_id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/inbox/reply', async (req, res) => {
  const { store_id, customer_id, message_text } = req.body;

  if (!store_id || !customer_id || !message_text) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  try {
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('facebook_page_access_token')
      .eq('id', store_id)
      .single();

    if (storeErr || !store?.facebook_page_access_token) {
      return res.status(400).json({ error: 'Facebook token not found for store.' });
    }

    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages`,
      {
        recipient: { id: customer_id },
        message: { text: message_text }
      },
      {
        params: { access_token: store.facebook_page_access_token }
      }
    );

    await supabase.from('chat_messages').insert({
      store_id: store_id,
      sender_psid: customer_id,
      role: 'agent',
      content: message_text,
      created_at: new Date().toISOString()
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Manual Reply Error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || 'Failed to send message.' });
  }
});

// Order status update route
app.post('/api/orders/update-status', async (req, res) => {
  const { order_id, status } = req.body;

  if (!order_id || !['pending', 'completed', 'dispatched', 'unconfirmed', 'confirmed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid parameters.' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', order_id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, order: data });
  } catch (err) {
    console.error('Error updating order status:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Start Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AI Sales Admin Server running on http://localhost:${PORT}`);
  console.log(`🧩 BUILD: ${BUILD_ID}`);
  console.log('🔐 WhatsApp code exchange mode: FB.login Embedded Signup → session event + code → server exchange');
  console.log(
    `📱 WhatsApp Embedded Signup config: ${
      WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID
        ? 'configured'
        : 'MISSING (set WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID)'
    }`
  );
  console.log(
    `📱 WhatsApp Graph API version: ${WHATSAPP_GRAPH_VERSION}`
  );
  console.log(
    `🛠️ WhatsApp JS SDK code-exchange redirect_uri: ${WHATSAPP_JS_SDK_REDIRECT_URI}`
  );
  console.log(`🛠️ WhatsApp JS SDK code-exchange redirect_uri: ${WHATSAPP_JS_SDK_REDIRECT_URI}`);
});