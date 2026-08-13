require('dotenv').config();
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());

// Serve static files (e.g. index.html) from the root directory
app.use(express.static(__dirname));

// Serve index.html on the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
   MULTI-TENANT DYNAMIC STORE & DATABASE LOOKUPS
   ========================================================================== */

/**
 * Resolve store settings & tokens from Supabase based on incoming platform ID
 */
async function getStoreByPlatformId({ whatsappPhoneId, facebookPageId, instagramAccountId }) {
  let query = supabase.from('stores').select('*');

  if (whatsappPhoneId) {
    query = query.eq('whatsapp_phone_number_id', String(whatsappPhoneId).trim());
  } else if (facebookPageId) {
    query = query.eq('facebook_page_id', String(facebookPageId).trim());
  } else if (instagramAccountId) {
    query = query.eq('instagram_account_id', String(instagramAccountId).trim());
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error('❌ Supabase Store Lookup Error:', error.message);
  }

  if (error || !data) {
    console.error(`⚠️ Store not found for incoming ID (WA: ${whatsappPhoneId}, FB: ${facebookPageId}, IG: ${instagramAccountId})`);
    return null;
  }

  return data;
}

/**
 * Fetch store-specific active inventory from Supabase
 */
async function getStoreInventory(storeId) {
  const { data, error } = await supabase
    .from('products')
    .select('id, title, price_npr, stock_quantity')
    .eq('store_id', storeId)
    .gt('stock_quantity', 0);

  if (error) {
    console.error(`Error fetching products for store ${storeId}:`, error);
    return 'No product data available.';
  }

  if (!data || data.length === 0) {
    return 'Currently all items are out of stock.';
  }

  return data
    .map(p => `- ${p.title}: NPR ${p.price_npr} (${p.stock_quantity} items available) [ID: ${p.id}]`)
    .join('\n');
}

/**
 * Save chat message to Supabase scoped to store_id and sender
 */
async function saveChatMessage(storeId, senderPsid, role, content) {
  try {
    const { error } = await supabase.from('chat_messages').insert([
      { store_id: storeId, sender_psid: senderPsid, role, content }
    ]);
    if (error) console.error('Error saving chat message:', error);
  } catch (err) {
    console.error('Error in saveChatMessage:', err);
  }
}

/**
 * Fetch past chat messages for a specific store and customer
 */
async function getChatHistory(storeId, senderPsid, limit = 8) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('store_id', storeId)
    .eq('sender_psid', senderPsid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.reverse().map(msg => ({ role: msg.role, content: msg.content }));
}

/**
 * Save customer order into Supabase for a specific store and deduct stock
 */
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
        delivery_charge_npr
      }
    ])
    .select();

  if (orderError) {
    console.error(`Error saving order for store ${store_id}:`, orderError);
    return { success: false, error: orderError.message };
  }

  // Deduct inventory stock for this store
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
    await saveChatMessage(store.id, senderPsid, 'assistant', aiReply);

    return aiReply;
  } catch (err) {
    console.error('Vision API Error:', err);
    return 'Hajur, photo analyze garda kehi samasya aayo. Kripaya text ma lekhera sodhnuhos.';
  }
}

async function processCustomerMessage(userMessage, senderPsid, store) {
  const inventoryList = await getStoreInventory(store.id);
  const chatHistory = await getChatHistory(store.id, senderPsid);

  const lowerMsg = userMessage.toLowerCase().trim();

  const orderDeclinedOrDelayed = lowerMsg.includes('paxi') || 
                                 lowerMsg.includes('pachi') || 
                                 lowerMsg.includes('ahile gardina') || 
                                 lowerMsg.includes('decide garera') || 
                                 lowerMsg.includes('haina pardaina') || 
                                 lowerMsg.includes('pardaina') || 
                                 lowerMsg.includes('nai');

  const isSimpleAck = lowerMsg === 'huss' || lowerMsg === 'okay' || lowerMsg === 'ok' || lowerMsg === 'dhanyabad' || lowerMsg === 'thank you';

  const lastAssistantMsg = [...chatHistory].reverse().find(m => m.role === 'assistant');
  const isOrderAlreadyConfirmed = lastAssistantMsg && lastAssistantMsg.content.includes('confirm bhayo');

  const shouldDisableTools = isOrderAlreadyConfirmed || orderDeclinedOrDelayed || isSimpleAck;

  const systemPrompt = `
You are a polite, natural, and helpful sales assistant for "${store.store_name}" in Kathmandu, Nepal.

STORE LIVE INVENTORY:
${inventoryList}

STRICT GRAMMAR & LANGUAGE DIRECTIVES:
- Speak strictly in clear, natural Romanized Nepali (Aadarthi Bhasa).
- Maintain short, concise sentences (1-2 sentences maximum).
- FORBIDDEN WORDS/PHRASES: NEVER use "pasand", "pasand aaucha", "koi", "aur", "sath", "chahiye", "karne sakchu", "puchnu".
- MANDATORY PHRASING:
  * Greeting: "Namaste hajur! ${store.store_name} ma swagat chha."
  * "Do you like this?": "Yo tapai lai mann parchha ki?"
  * "No problem": "Hajur, kehi xaina."
  * "Whenever you decide": "Hajur le decide garepachhi khabar garnuhola hai."

UPSELLING & REJECTION RULES:
1. If an item is NOT in stock, state it clearly: "Hajur, [item] ta aile stock ma chhaina."
2. You may suggest a similar item ONCE.
3. CRITICAL: If the customer insists on an out-of-stock item/color or declines an alternative, DO NOT PITCH ANY MORE PRODUCTS!
   - Reply gracefully: "Hajur, bujhe. Stock aune bittikai tapai lai khabar garnechhaum hai! Dhanyabad."

CRITICAL TOOL CALLING INSTRUCTION:
- DO NOT call saveOrder when the user says "Huss", "Paxi garxu", "Decide garera", "Haina pardaina", "Thank you", or asks a general question.
- Call saveOrder ONLY when the customer explicitly provides their Name, Phone Number, and Address with direct intent to place the order now.
`;

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
        orderReply = `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order (Order ID: #${orderResult.order.id}) confirm bhayo. Hami chhitai ${orderArgs.phone_number} ma call garera delivery confirm garnechha.`;
      } else {
        orderReply = 'Hajur, order confirm garda kehi samasya aayo. Kripaya full name ra phone number punah check garera pathaunu hola.';
      }

      await saveChatMessage(store.id, senderPsid, orderReply ? 'assistant' : 'system', orderReply);
      return orderReply;
    }
  }

  const rawReply = responseMessage.content || '';
  const aiReply = cleanAiResponse(rawReply) || 'Hajur, kehi technical samasya aayo. Kripaya feri prayas garnuhos.';
  await saveChatMessage(store.id, senderPsid, 'assistant', aiReply);

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

async function sendWhatsAppMessage(to, text, phoneId, accessToken) {
  try {
    const rawToken = accessToken || process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';
    const token = rawToken.trim();

    console.log(`🔑 Sending WA message using token prefix: ${token.substring(0, 12)}... (Length: ${token.length})`);

    const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
    
    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ WhatsApp Response sent to user (${to})`);
  } catch (error) {
    console.error('Error sending WhatsApp message:', JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

async function getWhatsAppMediaUrl(mediaId, accessToken) {
  try {
    const rawToken = accessToken || process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';
    const token = rawToken.trim();

    const mediaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return mediaRes.data.url;
  } catch (error) {
    console.error('Failed to get WhatsApp media URL:', error.message);
    return null;
  }
}

/* ==========================================================================
   STORE ONBOARDING API ROUTES
   ========================================================================== */

/**
 * POST /api/connect-all-channels
 * Automated One-Click Multi-Channel Onboarding endpoint using Meta User Access Token
 */
app.post('/api/connect-all-channels', async (req, res) => {
  try {
    const { store_name, user_access_token, wa_data } = req.body;

    if (!store_name || !user_access_token) {
      return res.status(400).json({ success: false, error: 'Store name and Meta access token are required.' });
    }

    const connectedChannels = [];
    let facebookPageId = null;
    let facebookPageAccessToken = null;
    let instagramAccountId = null;
    let whatsappPhoneNumberId = null;
    let whatsappAccessToken = null;

    // 1. Fetch Facebook Pages & Linked Instagram Accounts
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
        facebookPageId = primaryPage.id;
        facebookPageAccessToken = primaryPage.access_token;
        connectedChannels.push('Facebook Messenger');

        if (primaryPage.instagram_business_account && primaryPage.instagram_business_account.id) {
          instagramAccountId = primaryPage.instagram_business_account.id;
          connectedChannels.push('Instagram DMs');
        }

        // Subscribe Page to App Webhooks
        try {
          await axios.post(
            `https://graph.facebook.com/v20.0/${facebookPageId}/subscribed_apps`,
            null,
            {
              params: {
                access_token: facebookPageAccessToken,
                subscribed_fields: 'messages,messaging_postbacks'
              }
            }
          );
          console.log(`✅ Successfully subscribed Page (${facebookPageId}) to App webhooks.`);
        } catch (subErr) {
          console.warn('⚠️ Webhook subscription notice:', subErr.response?.data?.error?.message || subErr.message);
        }
      }
    } catch (fbErr) {
      console.error('⚠️ Error fetching Meta Pages:', fbErr.response?.data || fbErr.message);
    }

    // 2. Resolve WhatsApp Cloud API Details Safely
    if (wa_data && wa_data.phone_number_id) {
      whatsappPhoneNumberId = String(wa_data.phone_number_id).trim();
      whatsappAccessToken = user_access_token;
      connectedChannels.push('WhatsApp Cloud API');
    } else {
      try {
        // Step A: Fetch Meta Business Accounts owned by or linked to the user
        const bizRes = await axios.get('https://graph.facebook.com/v20.0/me/businesses', {
          params: { access_token: user_access_token }
        });

        const businesses = bizRes.data?.data || [];
        let waAccId = null;

        for (const biz of businesses) {
          // Step B: Fetch WhatsApp Business Accounts under each business
          const waAccRes = await axios.get(`https://graph.facebook.com/v20.0/${biz.id}/whatsapp_business_accounts`, {
            params: { access_token: user_access_token }
          });
          
          const waAccounts = waAccRes.data?.data || [];
          if (waAccounts.length > 0) {
            waAccId = waAccounts[0].id;
            break;
          }
        }

        // Step C: Fetch Phone Numbers for the discovered WhatsApp Business Account
        if (waAccId) {
          const phoneRes = await axios.get(`https://graph.facebook.com/v20.0/${waAccId}/phone_numbers`, {
            params: { access_token: user_access_token }
          });
          const phoneNumbers = phoneRes.data?.data || [];
          if (phoneNumbers.length > 0) {
            whatsappPhoneNumberId = phoneNumbers[0].id;
            whatsappAccessToken = user_access_token;
            connectedChannels.push('WhatsApp Cloud API');
          }
        }
      } catch (waErr) {
        console.warn('⚠️ WhatsApp details skipped or unavailable:', waErr.response?.data?.error?.message || waErr.message);
      }
    }

    if (connectedChannels.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No active Facebook Page, Instagram Account, or WhatsApp Business account was found under this Meta profile.'
      });
    }

    // Save/Insert into Supabase 'stores'
    const payload = {
      store_name: store_name.trim(),
      whatsapp_phone_number_id: whatsappPhoneNumberId,
      whatsapp_access_token: whatsappAccessToken,
      facebook_page_id: facebookPageId,
      facebook_page_access_token: facebookPageAccessToken,
      instagram_account_id: instagramAccountId
    };

    const { data, error } = await supabase
      .from('stores')
      .insert([payload])
      .select();

    if (error) {
      console.error('❌ Supabase insert error in automated onboarding:', error.message);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log(`✅ Store "${store_name}" automatically connected with channels: ${connectedChannels.join(', ')}`);
    return res.status(201).json({
      success: true,
      connectedChannels,
      store: data[0]
    });

  } catch (err) {
    console.error('❌ Server Error during automated channel onboarding:', err);
    return res.status(500).json({ success: false, error: 'Internal server error during automated setup.' });
  }
});

/**
 * POST /api/onboard-store
 * Registers a new store with manual multi-channel credentials.
 */
app.post('/api/onboard-store', async (req, res) => {
  try {
    const {
      store_name,
      whatsapp_phone_number_id,
      whatsapp_access_token,
      facebook_page_id,
      facebook_page_access_token,
      instagram_account_id
    } = req.body;

    if (!store_name) {
      return res.status(400).json({ success: false, error: 'Store name is required.' });
    }

    // Clean / Trim input parameters if present
    const payload = {
      store_name: store_name.trim(),
      whatsapp_phone_number_id: whatsapp_phone_number_id ? String(whatsapp_phone_number_id).trim() : null,
      whatsapp_access_token: whatsapp_access_token ? String(whatsapp_access_token).trim() : null,
      facebook_page_id: facebook_page_id ? String(facebook_page_id).trim() : null,
      facebook_page_access_token: facebook_page_access_token ? String(facebook_page_access_token).trim() : null,
      instagram_account_id: instagram_account_id ? String(instagram_account_id).trim() : null
    };

    const { data, error } = await supabase
      .from('stores')
      .insert([payload])
      .select();

    if (error) {
      console.error('❌ Onboarding Error:', error.message);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log(`✅ Store "${store_name}" onboarded successfully!`);
    return res.status(201).json({
      success: true,
      message: 'Store onboarded successfully',
      store: data[0]
    });

  } catch (err) {
    console.error('❌ Server Error during store onboarding:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ==========================================================================
   1. META MESSENGER & INSTAGRAM WEBHOOK ROUTES
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
      const pageOrIgId = entry.id; // Recipient Page ID or Instagram Account ID
      let messagingEvents = entry.messaging || [];
      if (!entry.messaging && entry.changes) {
        messagingEvents = entry.changes.map(change => change.value).filter(val => val && val.message);
      }

      for (const webhookEvent of messagingEvents) {
        const messageId = webhookEvent.message ? webhookEvent.message.mid : null;

        if (trackProcessedMessageId(messageId)) {
          console.log(`⚠️ Skipping duplicate Messenger/IG message ID: ${messageId}`);
          continue;
        }

        const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
        if (!senderPsid || (webhookEvent.message && webhookEvent.message.is_echo)) continue;

        // Dynamic store resolution
        const store = await getStoreByPlatformId({
          facebookPageId: pageOrIgId,
          instagramAccountId: pageOrIgId
        });

        if (!store) {
          console.error(`Store not registered for Facebook/Instagram ID: ${pageOrIgId}`);
          continue;
        }

        const token = store.facebook_page_access_token || process.env.META_ACCESS_TOKEN;

        if (webhookEvent.message && webhookEvent.message.text) {
          const userText = webhookEvent.message.text;
          console.log(`💬 Message received from ${senderPsid} [Store: ${store.store_name}]: "${userText}"`);

          try {
            const aiReply = await processCustomerMessage(userText, senderPsid, store);
            console.log(`🤖 AI Reply: "${aiReply}"`);
            await sendTextMessage(senderPsid, aiReply, token);
          } catch (err) {
            console.error('❌ Error processing text message:', err);
          }
        } 
        else if (webhookEvent.message && webhookEvent.message.attachments) {
          const imageAttachment = webhookEvent.message.attachments.find(att => att.type === 'image');

          if (imageAttachment && imageAttachment.payload && imageAttachment.payload.url) {
            const imageUrl = imageAttachment.payload.url;
            console.log(`🖼️ Image received from ${senderPsid} [Store: ${store.store_name}]: ${imageUrl}`);

            try {
              const aiReply = await processCustomerImage(imageUrl, senderPsid, store);
              console.log(`🤖 AI Vision Reply: "${aiReply}"`);
              await sendTextMessage(senderPsid, aiReply, token);
            } catch (err) {
              console.error('❌ Error processing image:', err);
            }
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

/* ==========================================================================
   2. WHATSAPP CLOUD API WEBHOOK ROUTES
   ========================================================================== */

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[WhatsApp Webhook] Verified successfully.');
    return res.status(200).send(challenge);
  }

  console.error('[WhatsApp Webhook Verification Failed]: Mismatched token');
  return res.sendStatus(403);
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const recipientPhoneNumberId = value?.metadata?.phone_number_id;
    const customerPhone = message.from;
    const messageId = message.id;

    if (trackProcessedMessageId(messageId)) {
      console.log(`⚠️ Skipping duplicate WhatsApp message ID: ${messageId}`);
      return;
    }

    // Dynamic Store Resolution by WhatsApp Phone Number ID
    const store = await getStoreByPlatformId({ whatsappPhoneId: recipientPhoneNumberId });

    if (!store) {
      console.error(`Store not registered for WhatsApp Phone Number ID: ${recipientPhoneNumberId}`);
      return;
    }

    const waAccessToken = store.whatsapp_access_token || process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

    if (message.type === 'text') {
      const userText = message.text.body;
      console.log(`💬 WhatsApp from ${customerPhone} [Store: ${store.store_name}]: "${userText}"`);

      const aiReply = await processCustomerMessage(userText, customerPhone, store);
      console.log(`🤖 AI Reply (WhatsApp): "${aiReply}"`);
      await sendWhatsAppMessage(customerPhone, aiReply, recipientPhoneNumberId, waAccessToken);

    } else if (message.type === 'image') {
      const imageUrl = await getWhatsAppMediaUrl(message.image.id, waAccessToken);
      console.log(`🖼️ WhatsApp Image from ${customerPhone} [Store: ${store.store_name}]: ${imageUrl}`);

      if (imageUrl) {
        const aiReply = await processCustomerImage(imageUrl, customerPhone, store);
        console.log(`🤖 AI Vision Reply (WhatsApp): "${aiReply}"`);
        await sendWhatsAppMessage(customerPhone, aiReply, recipientPhoneNumberId, waAccessToken);
      } else {
        await sendWhatsAppMessage(customerPhone, 'Hajur, photo clear dekhiyana. Kripaya punah photo pathaunu hola.', recipientPhoneNumberId, waAccessToken);
      }
    }
  } catch (error) {
    console.error('❌ WhatsApp Message Processing Error:', error);
  }
});

/* ==========================================================================
   SERVER INITIALIZATION
   ========================================================================== */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Multi-Tenant Server running on port ${PORT}`);
});