require('dotenv').config();
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');

// Ensure process.env.SUPABASE_KEY matches your Render environment variable name
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

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

const app = express();
app.use(express.json());

// Serve static files (e.g. index.html, dashboard.html, signup.html, login.html)
app.use(express.static(__dirname));

// Serve Auth Pages
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve Dashboard
app.get('/dashboard', (req, res) => {
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
  try {
    const { storeName, email, password } = req.body;

    if (!storeName || !email || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // 1. Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 2. Insert directly into stores table
    const { data: store, error: storeError } = await supabaseAdmin
      .from('stores')
      .insert([
        {
          store_name: storeName.trim(),
          email: cleanEmail,
          password: hashedPassword
        }
      ])
      .select()
      .single();

    if (storeError) {
      console.error("Signup DB Error:", storeError.message);
      return res.status(400).json({ success: false, error: 'Email already registered or database error.' });
    }

    return res.json({
      success: true,
      message: 'Account created successfully!',
      store: store
    });

  } catch (err) {
    console.error("Signup Catch Error:", err);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    console.log("=== LOGIN REQUEST RECEIVED ===");
    console.log("Req Body:", req.body);

    const { email, password } = req.body;

    if (!email || !password) {
      console.log("Missing fields:", { email: !!email, password: !!password });
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

    console.log("DB Store Record Found:", store);

    if (storeError || !store) {
      console.log("Store Lookup Failed:", storeError?.message);
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

    // Direct password match check (supports both bcrypt and plaintext fallbacks)
    let isMatch = false;
    if (store.password && store.password.startsWith('$2a$')) {
      isMatch = await bcrypt.compare(cleanPassword, store.password);
    } else {
      isMatch = (cleanPassword === store.password);
    }

    console.log("Password Match Result:", isMatch);

    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }

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
  const targetId = String(whatsappPhoneId || facebookPageId || instagramAccountId || '').trim();
  if (!targetId) return null;

  try {
    const { data: channel, error: channelErr } = await supabase
      .from('store_channels')
      .select('*, stores(*)')
      .eq('channel_id', targetId)
      .maybeSingle();

    if (!channelErr && channel) {
      const storeData = Array.isArray(channel.stores) ? channel.stores[0] : channel.stores;
      if (storeData) {
        return {
          ...storeData,
          facebook_page_access_token: channel.access_token || storeData.facebook_page_access_token,
          whatsapp_access_token: channel.access_token || storeData.whatsapp_access_token,
          active_channel_id: channel.channel_id
        };
      }
    }

    let query = supabase.from('stores').select('*');
    if (whatsappPhoneId) {
      query = query.eq('whatsapp_phone_number_id', String(whatsappPhoneId).trim());
    } else if (facebookPageId) {
      query = query.eq('facebook_page_id', String(facebookPageId).trim());
    } else if (instagramAccountId) {
      query = query.eq('instagram_account_id', String(instagramAccountId).trim());
    }

    const { data: directStore, error: directErr } = await query.maybeSingle();
    if (!directErr && directStore) {
      return directStore;
    }

    console.error(`⚠️ Store not found for incoming ID: ${targetId}`);
    return null;
  } catch (err) {
    console.error('❌ Error during store lookup:', err.message);
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

  const { data: orderData, error: orderError } = await supabase
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

  const { data: prodData } = await supabase
    .from('products')
    .select('id, stock_quantity')
    .eq('store_id', store_id)
    .ilike('title', `%${product_title}%`)
    .maybeSingle();

  if (prodData) {
    const newStock = Math.max(0, prodData.stock_quantity - orderQuantity);
    await supabase
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
      model: 'qwen/qwen3.6-27b',
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
  // 1. Fetch current product catalog for this store from Supabase
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('store_id', store.id);

  // 2. Format catalog into readable text for the AI
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

  /* --------------------------------------------------------------------------
     FEATURE 1: AUTOMATED COD CONFIRMATION INTERCEPTION ("YES" / "CONFIRM")
     -------------------------------------------------------------------------- */
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

  // 3. Inject inventory context directly into System Prompt
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
    model: 'openai/gpt-oss-120b',
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

    const pathaoResponse = await axios.post(
      `${process.env.PATHAO_BASE_URL || 'https://api-hermes.pathao.com'}/aladdin/api/v1/orders`,
      {
        store_id: process.env.PATHAO_STORE_ID,
        recipient_name: order.customer_name,
        recipient_phone: order.phone_number,
        recipient_address: order.delivery_location,
        amount_to_collect: order.total_price_npr + order.delivery_charge_npr,
        item_type: 2, // Parcel
        delivery_type: 48, // Standard Delivery
        item_quantity: order.quantity,
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
    const { data } = await supabase
      .from('stores')
      .select('*')
      .eq('facebook_page_id', String(storePayload.facebook_page_id))
      .maybeSingle();
    if (data) existingStore = data;
  }

  if (!existingStore && storePayload.whatsapp_phone_number_id) {
    const { data } = await supabase
      .from('stores')
      .select('*')
      .eq('whatsapp_phone_number_id', String(storePayload.whatsapp_phone_number_id))
      .maybeSingle();
    if (data) existingStore = data;
  }

  if (!existingStore && storePayload.instagram_account_id) {
    const { data } = await supabase
      .from('stores')
      .select('*')
      .eq('instagram_account_id', String(storePayload.instagram_account_id))
      .maybeSingle();
    if (data) existingStore = data;
  }

  if (existingStore) {
    const { data, error } = await supabase
      .from('stores')
      .update(storePayload)
      .eq('id', existingStore.id)
      .select();
    if (error) throw error;
    return data[0];
  } else {
    const { data, error } = await supabase
      .from('stores')
      .insert([storePayload])
      .select();

    if (error) throw error;
    return data[0];
  }
}

async function saveStoreChannels(storeId, channels) {
  for (const ch of channels) {
    if (ch.channel_id) {
      const channelRow = {
        store_id: String(storeId),
        channel_type: ch.channel_type,
        channel_id: String(ch.channel_id).trim()
      };
      if (ch.access_token) {
        channelRow.access_token = String(ch.access_token).trim();
      }

      const { data: existingChannel } = await supabase
        .from('store_channels')
        .select('id')
        .eq('channel_id', channelRow.channel_id)
        .maybeSingle();

      if (existingChannel) {
        await supabase
          .from('store_channels')
          .update(channelRow)
          .eq('id', existingChannel.id);
      } else {
        await supabase
          .from('store_channels')
          .insert([channelRow]);
      }
    }
  }
}

/* ==========================================================================
   SOCIAL CHANNEL OAUTH CONNECT ROUTES (FACEBOOK & WHATSAPP)
   ========================================================================== */

// 1. Facebook & Instagram Connect Route
app.get('/auth/facebook', (req, res) => {
  const storeId = req.query.store_id;
  if (!storeId) return res.status(400).send('Missing store_id parameter.');

  const appId = process.env.META_APP_ID;
  const redirectUri = encodeURIComponent(`https://${req.get('host')}/auth/facebook/callback`);
  const scope = encodeURIComponent('pages_show_list,pages_messaging,pages_read_engagement,instagram_basic,instagram_manage_messages');

  const fbAuthUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${storeId}`;
  res.redirect(fbAuthUrl);
});

// Facebook Callback Handler
app.get('/auth/facebook/callback', async (req, res) => {
  const { code, state: storeId } = req.query;
  if (!code || !storeId) return res.status(400).send('Authentication failed or store_id missing.');

  try {
    const redirectUri = `https://${req.get('host')}/auth/facebook/callback`;
    
    const tokenRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code: code
      }
    });

    const userToken = tokenRes.data.access_token;
    
    const pageRes = await axios.get('https://graph.facebook.com/v20.0/me/accounts', {
      params: { access_token: userToken, fields: 'id,name,access_token,instagram_business_account' }
    });

    const page = pageRes.data?.data?.[0];
    if (page) {
      await supabaseAdmin.from('stores').update({
        facebook_page_id: page.id,
        facebook_page_access_token: page.access_token,
        instagram_account_id: page.instagram_business_account?.id || null
      }).eq('id', storeId);
    }

    res.redirect(`/dashboard?store_id=${storeId}`);
  } catch (err) {
    console.error('FB Auth Error:', err.response?.data || err.message);
    res.status(500).send('Failed to complete Facebook OAuth.');
  }
});

// 2. WhatsApp Connect Initiation Route
app.get('/auth/whatsapp', (req, res) => {
  const storeId = req.query.store_id;
  if (!storeId) return res.status(400).send('Missing store_id parameter.');

  const appId = process.env.META_APP_ID;
  const redirectUri = encodeURIComponent(`https://${req.get('host')}/auth/whatsapp/callback`);
  const scope = encodeURIComponent('whatsapp_business_management,whatsapp_business_messaging');

  const waAuthUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${storeId}`;
  res.redirect(waAuthUrl);
});

// Robust WhatsApp Callback Handler
app.get('/auth/whatsapp/callback', async (req, res) => {
  const code = req.query.code;
  const storeId = req.query.state || req.query.store_id;

  if (!code) return res.status(400).send('WhatsApp OAuth failed: Missing authorization code.');
  if (!storeId) return res.status(400).send('WhatsApp OAuth failed: Missing store_id state.');

  try {
    const redirectUri = `https://${req.get('host')}/auth/whatsapp/callback`;

    const tokenRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code: code
      }
    });

    const userToken = tokenRes.data.access_token;

    const waAccountRes = await axios.get('https://graph.facebook.com/v20.0/me/whatsapp_business_accounts', {
      params: { access_token: userToken }
    }).catch(() => null);

    const wabaId = waAccountRes?.data?.data?.[0]?.id;

    if (wabaId) {
      const phoneRes = await axios.get(`https://graph.facebook.com/v20.0/${wabaId}/phone_numbers`, {
        params: { access_token: userToken }
      }).catch(() => null);

      const phoneNumId = phoneRes?.data?.data?.[0]?.id;

      await supabaseAdmin.from('stores').update({
        whatsapp_phone_number_id: phoneNumId || null,
        whatsapp_access_token: userToken
      }).eq('id', storeId);
    } else {
      await supabaseAdmin.from('stores').update({
        whatsapp_access_token: userToken
      }).eq('id', storeId);
    }

    res.redirect(`/dashboard?store_id=${storeId}`);
  } catch (err) {
    console.error('WhatsApp Auth Detailed Error:', err.response?.data || err.message);
    res.status(500).send(`Failed to complete WhatsApp OAuth: ${err.response?.data?.error?.message || err.message}`);
  }
});

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
    const storeId = req.query.store_id;

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
// Add product to store catalog
app.post('/api/products', async (req, res) => {
  try {
    const { store_id, name, price, stock_quantity, description } = req.body;

    if (!store_id || !name || price === undefined) {
      return res.status(400).json({ error: 'Missing required product parameters.' });
    }

    // Payload prepared for Supabase insert
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

  if (body.object === 'page' || body.object === 'instagram') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry || []) {
      const pageOrIgId = entry.id;

      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'comments' || change.field === 'feed') {
            await handleCommentEvent(change.value, pageOrIgId);
          }
        }
      }

      const messagingEvents = entry.messaging || [];

      for (const messagingEvent of messagingEvents) {
        const senderPsid = messagingEvent.sender?.id || messagingEvent.from?.id;
        const messageId = messagingEvent.message?.mid || messagingEvent.id;

        if (!senderPsid || messagingEvent.message?.is_echo) continue;
        if (trackProcessedMessageId(messageId)) continue;

        const store = await getStoreByPlatformId({
          facebookPageId: pageOrIgId,
          instagramAccountId: pageOrIgId
        });

        if (!store) continue;

        const rawToken = store.facebook_page_access_token || process.env.META_ACCESS_TOKEN || '';

        if (messagingEvent.message?.attachments) {
          const imgUrl = messagingEvent.message.attachments[0]?.payload?.url;
          if (imgUrl) {
            const aiReply = await processCustomerImage(imgUrl, senderPsid, store);
            await sendTextMessage(senderPsid, aiReply, rawToken);
          }
        } else if (messagingEvent.message?.text) {
          const userMsg = messagingEvent.message.text;
          const aiReply = await processCustomerMessage(userMsg, senderPsid, store);
          await sendTextMessage(senderPsid, aiReply, rawToken);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

/* ==========================================================================
   UNIFIED MULTI-CHANNEL INBOX ENDPOINTS (STRICTLY SCOPED)
   ========================================================================== */

// Serve Inbox Page without caching
app.get('/inbox', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'inbox.html'));
});

// Fetch distinct conversation threads for a specific store
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

// Fetch full thread history for a single customer scoped to store_id
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

// Start Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AI Sales Admin Server running on http://localhost:${PORT}`);
});