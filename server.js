require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Initialize Clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Clean AI output by stripping internal reasoning steps and enforcing length limits
 */
function cleanAiResponse(text) {
  if (!text) return '';

  let cleaned = text;
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

  if (cleaned.includes('Namaste') || cleaned.includes('Hajur')) {
    const namasteIndex = cleaned.lastIndexOf('Namaste');
    const hajurIndex = cleaned.lastIndexOf('Hajur');
    const startIdx = Math.max(namasteIndex, hajurIndex);
    if (startIdx !== -1) {
      cleaned = cleaned.substring(startIdx);
    }
  }

  cleaned = cleaned.trim().replace(/^["']|["']$/g, '');

  if (cleaned.length > 1900) {
    cleaned = cleaned.substring(0, 1900) + '...';
  }

  return cleaned;
}

/**
 * Dynamically resolve store_id using channel_id (Page ID, IG Account ID, WA Phone Number ID)
 */
async function resolveStoreId(channelId, defaultStore = 'himalayan_wear') {
  if (!channelId) return defaultStore;

  const { data, error } = await supabase
    .from('store_channels')
    .select('store_id')
    .eq('channel_id', channelId)
    .single();

  if (error || !data) return defaultStore;
  return data.store_id;
}

/**
 * Fetch available products for a store
 */
async function getStoreInventory(storeId) {
  const { data, error } = await supabase
    .from('products')
    .select('id, title, price_npr, stock_quantity')
    .eq('store_id', storeId)
    .gt('stock_quantity', 0);

  if (error || !data || data.length === 0) {
    return 'Currently all items are out of stock.';
  }

  return data
    .map(p => `- ${p.title}: NPR ${p.price_npr} (${p.stock_quantity} available) [ID: ${p.id}]`)
    .join('\n');
}

/**
 * Chat History & Order Helpers
 */
async function saveChatMessage(senderPsid, role, content) {
  try {
    await supabase.from('chat_messages').insert([{ sender_psid: senderPsid, role, content }]);
  } catch (err) {
    console.error('Error saving chat message:', err);
  }
}

async function getChatHistory(senderPsid, limit = 6) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('sender_psid', senderPsid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.reverse().map(msg => ({ role: msg.role, content: msg.content }));
}

async function saveOrder({ customer_name, phone_number, delivery_location, product_title, quantity, total_price_npr, delivery_charge_npr, store_id }) {
  const orderQuantity = quantity || 1;

  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .insert([{ store_id, customer_name, phone_number, delivery_location, product_title, quantity: orderQuantity, total_price_npr, delivery_charge_npr }])
    .select();

  if (orderError) return { success: false, error: orderError.message };

  const { data: prodData } = await supabase
    .from('products')
    .select('id, stock_quantity')
    .eq('store_id', store_id)
    .ilike('title', `%${product_title}%`)
    .single();

  if (prodData) {
    const newStock = Math.max(0, prodData.stock_quantity - orderQuantity);
    await supabase.from('products').update({ stock_quantity: newStock }).eq('id', prodData.id);
  }

  return { success: true, order: orderData[0] };
}

const orderTool = {
  type: 'function',
  function: {
    name: 'saveOrder',
    description: 'Save customer order details when full information is provided.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        phone_number: { type: 'string' },
        delivery_location: { type: 'string' },
        product_title: { type: 'string' },
        quantity: { type: 'integer' },
        total_price_npr: { type: 'number' },
        delivery_charge_npr: { type: 'number' }
      },
      required: ['customer_name', 'phone_number', 'delivery_location', 'product_title', 'total_price_npr', 'delivery_charge_npr']
    }
  }
};

/**
 * Vision & Text Message Processing
 */
async function processCustomerImage(imageUrl, senderPsid, storeId) {
  const inventoryList = await getStoreInventory(storeId);

  try {
    const imageResponse = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const visionPrompt = `
You are a warm sales assistant for an online shop in Nepal.

CURRENT STORE INVENTORY:
${inventoryList}

STRICT LANGUAGE & TONE:
1. Respond ONLY in polite Romanized Nepali (Aadarthi Bhasa).
2. Use "Tapai", "Tapai lai", "Hajur", "Namaste!".
3. NO thinking tags or English explanations.
4. Keep under 300 characters.
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
      temperature: 0.2
    });

    const rawReply = visionResponse.choices[0]?.message?.content || '';
    const aiReply = cleanAiResponse(rawReply) || 'Namaste hajur! Photo clear dekhiyana, kripaya punah photo pathaunu hola.';

    await saveChatMessage(senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(senderPsid, 'assistant', aiReply);
    return aiReply;
  } catch (err) {
    console.error('Groq Vision Error:', err);
    return 'Namaste hajur, photo analyze garda kehi technical samasya aayo. Kripaya item ko naam text ma lekhera sodhnuhos!';
  }
}

async function processCustomerMessage(userMessage, senderPsid, storeId) {
  const inventoryList = await getStoreInventory(storeId);
  const chatHistory = await getChatHistory(senderPsid);

  const systemPrompt = `
You are a warm sales assistant for an online store in Nepal.

CURRENT LIVE INVENTORY:
${inventoryList}

STRICT LANGUAGE RULES:
1. Respond ONLY in natural, polite Romanized Nepali (Aadarthi Bhasa).
2. NEVER use "Timi". ALWAYS use "Tapai", "Tapai lai", "Hajur".
3. Keep response brief (under 400 characters).
`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await groq.chat.completions.create({
    messages,
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    tools: [orderTool],
    tool_choice: 'auto'
  });

  const responseMessage = response.choices[0]?.message;
  await saveChatMessage(senderPsid, 'user', userMessage);

  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    const toolCall = responseMessage.tool_calls[0];
    if (toolCall.function.name === 'saveOrder') {
      const orderArgs = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;

      orderArgs.store_id = storeId;
      const orderResult = await saveOrder(orderArgs);

      const orderReply = orderResult.success
        ? `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order (Order ID: #${orderResult.order.id}) confirm bhayo.`
        : 'Hajur, order confirm garda kehi technical samasya aayo.';

      await saveChatMessage(senderPsid, 'assistant', orderReply);
      return orderReply;
    }
  }

  const rawReply = responseMessage.content || '';
  const aiReply = cleanAiResponse(rawReply) || 'Namaste hajur, kehi technical samasya aayo.';
  await saveChatMessage(senderPsid, 'assistant', aiReply);
  return aiReply;
}

/**
 * Message Dispatchers for Meta Graph API & WhatsApp Cloud API
 */
async function sendMetaTextMessage(senderPsid, responseText, channelId, objectType = 'page') {
  try {
    // If it's an Instagram event, use the Instagram Account ID directly
    let endpointId = '1179970958543225'; // Default Facebook Page ID
    if (objectType === 'instagram') {
      endpointId = '17841442829434138'; // Your Instagram Business Account ID
    } else if (channelId && channelId.startsWith('178')) {
      endpointId = channelId;
    }
    
    const res = await fetch(`https://graph.facebook.com/v18.0/${endpointId}/messages?access_token=${process.env.META_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: senderPsid }, message: { text: responseText } })
    });
    const data = await res.json();
    if (data.error) {
      console.error('Meta Send Error:', data.error);
    } else {
      console.log('✅ Meta Message Sent Successfully to:', senderPsid);
    }
  } catch (error) {
    console.error('Error sending Meta message:', error);
  }
}

async function sendWhatsAppTextMessage(phoneId, toPhoneNumber, responseText) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhoneNumber,
        text: { body: responseText }
      })
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
  }
}

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// Universal Webhook Handler
app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.status(200).send('EVENT_RECEIVED');

  console.log('📩 INCOMING WEBHOOK EVENT:', JSON.stringify(body, null, 2));

  // Handle Messenger & Instagram DMs
  if (body.object === 'page' || body.object === 'instagram') {
    for (const entry of body.entry) {
      const channelId = entry.id; // Page ID or Instagram Account ID
      const storeId = await resolveStoreId(channelId);

      let messagingEvents = entry.messaging || [];
      if (!entry.messaging && entry.changes) {
        messagingEvents = entry.changes.map(change => change.value).filter(val => val && val.message);
      }

      for (const event of messagingEvents) {
        const senderPsid = event.sender ? event.sender.id : null;
        if (!senderPsid || (event.message && event.message.is_echo)) continue;

        if (event.message && event.message.text) {
          console.log(`💬 User (${senderPsid}):`, event.message.text);
          const aiReply = await processCustomerMessage(event.message.text, senderPsid, storeId);
          console.log(`🤖 AI Reply:`, aiReply);
          await sendMetaTextMessage(senderPsid, aiReply, channelId, body.object); // Pass body.object here
        } else if (event.message && event.message.attachments) {
          const img = event.message.attachments.find(a => a.type === 'image');
          if (img && img.payload && img.payload.url) {
            console.log(`🖼️ User sent an image:`, img.payload.url);
            const aiReply = await processCustomerImage(img.payload.url, senderPsid, storeId);
            console.log(`🤖 AI Reply:`, aiReply);
            await sendMetaTextMessage(senderPsid, aiReply, channelId, body.object); // Pass body.object here
          }
        }
  // Handle WhatsApp Messages
  else if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        const phoneId = value.metadata ? value.metadata.phone_number_id : null;
        const storeId = await resolveStoreId(phoneId);

        if (!value.messages || value.messages.length === 0) continue;

        const message = value.messages[0];
        const fromNumber = message.from;

        if (message.type === 'text') {
          console.log(`💬 WhatsApp User (${fromNumber}):`, message.text.body);
          const aiReply = await processCustomerMessage(message.text.body, fromNumber, storeId);
          console.log(`🤖 AI Reply:`, aiReply);
          await sendWhatsAppTextMessage(phoneId, fromNumber, aiReply);
        }
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Multi-Channel Bot running on port ${PORT}`));