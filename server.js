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
 * Clean AI output by stripping internal reasoning/thinking steps and enforcing Meta's length limits
 */
function cleanAiResponse(text) {
  if (!text) return '';

  let cleaned = text;

  // 1. Remove standard <think>...</think> tags if present
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 2. Extract only the final conversational message starting at "Namaste" or "Hajur"
  if (cleaned.includes('Namaste') || cleaned.includes('Hajur')) {
    const namasteIndex = cleaned.lastIndexOf('Namaste');
    const hajurIndex = cleaned.lastIndexOf('Hajur');
    const startIdx = Math.max(namasteIndex, hajurIndex);
    
    if (startIdx !== -1) {
      cleaned = cleaned.substring(startIdx);
    }
  }

  // 3. Trim extra spaces and outer quote marks
  cleaned = cleaned.trim().replace(/^["']|["']$/g, '');

  // 4. Enforce Meta's strict length restriction (max 2000 chars)
  if (cleaned.length > 1900) {
    cleaned = cleaned.substring(0, 1900) + '...';
  }

  return cleaned;
}

/**
 * Fetch available products for a specific store from Supabase database
 */
async function getStoreInventory(storeId = 'himalayan_wear') {
  const { data, error } = await supabase
    .from('products')
    .select('id, title, price_npr, stock_quantity')
    .eq('store_id', storeId)
    .gt('stock_quantity', 0);

  if (error) {
    console.error('Error fetching products from Supabase:', error);
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
 * Save chat message to Supabase
 */
async function saveChatMessage(senderPsid, role, content) {
  try {
    const { error } = await supabase.from('chat_messages').insert([
      { sender_psid: senderPsid, role, content }
    ]);
    if (error) console.error('Error saving chat message:', error);
  } catch (err) {
    console.error('Error saving chat message:', err);
  }
}

/**
 * Fetch past chat messages for conversation history
 */
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

/**
 * Save customer order into Supabase
 */
async function saveOrder({ customer_name, phone_number, delivery_location, product_title, quantity, total_price_npr, delivery_charge_npr, store_id = 'himalayan_wear' }) {
  const orderQuantity = quantity || 1;

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
    console.error('Error saving order to Supabase:', orderError);
    return { success: false, error: orderError.message };
  }

  const { data: prodData } = await supabase
    .from('products')
    .select('id, stock_quantity')
    .eq('store_id', store_id)
    .ilike('title', `%${product_title}%`)
    .single();

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
    description: 'Save a customer order when full details are provided.',
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
 * Handle incoming image attachments using Groq Vision API
 */
async function processCustomerImage(imageUrl, senderPsid, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);

  try {
    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const visionPrompt = `
You are a warm, extremely polite sales representative for "Himalayan Wear" in Nepal.

CURRENT STORE INVENTORY:
${inventoryList}

STRICT LANGUAGE & TONE RULES:
1. Respond ONLY in extremely polite, natural Romanized Nepali (Aadarthi Bhasa).
2. NEVER use informal words like "Timi", "Timro", "Kya timi", or "Timi le".
3. ALWAYS use respectful forms like "Tapai", "Tapai le", "Tapai lai", "Hajur".
4. Speak like a polite Nepali shopkeeper on Messenger:
   - "Namaste hajur! Himalayan Wear ma swagat cha."
   - "Tapai le pathaunu bhayeko photo ma..."
   - "Hami sanga yo exact item available chaina, tara..."
   - "Ke tapai lai yo man parcha hajur?"
5. DO NOT output reasoning tags (<think>), checklists, or English sentences.
6. Keep the response short (under 300 characters).

TASK:
1. Identify the item in the image (color, apparel type).
2. Check inventory above.
3. Tell customer politely if available, or suggest similar items in stock with price.
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
    console.error('Groq Vision Error:', err.message || err);

    const fallbackReply = 'Namaste hajur, photo analyze garda kehi technical samasya aayo. Kripaya item ko naam text ma lekhera sodhnuhos!';

    await saveChatMessage(senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(senderPsid, 'assistant', fallbackReply);

    return fallbackReply;
  }
}

/**
 * Process customer text message
 */
async function processCustomerMessage(userMessage, senderPsid, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);
  const chatHistory = await getChatHistory(senderPsid);

  const systemPrompt = `
You are a warm, extremely polite sales assistant for "Himalayan Wear", an online clothing store in Nepal.

CURRENT LIVE INVENTORY:
${inventoryList}

STRICT LANGUAGE & TONE RULES:
1. Respond ONLY in natural, polite Romanized Nepali (Aadarthi Bhasa).
2. NEVER use informal pronouns ("Timi", "Timro"). ALWAYS use polite forms ("Tapai", "Tapai lai", "Hajur").
3. Use natural, friendly Nepali shopkeeper phrasing:
   - "Namaste hajur! Himalayan Wear ma swagat cha."
   - "Hami sanga yo item available cha hajur."
   - "Tapai ko order confirm garna sakchau."
4. DO NOT write any English sentences or output reasoning tags (<think>).
5. Keep response lengths brief (under 400 characters).
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

      let orderReply = '';
      if (orderResult.success) {
        orderReply = `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order (Order ID: #${orderResult.order.id}) confirm bhayo. Hami chhitai ${orderArgs.phone_number} ma call garera delivery confirm garnechha.`;
      } else {
        orderReply = 'Hajur, order confirm garda kehi technical samasya aayo. Kripaya punah prayas garnuhos.';
      }

      await saveChatMessage(senderPsid, 'assistant', orderReply);
      return orderReply;
    }
  }

  const rawReply = responseMessage.content || '';
  const aiReply = cleanAiResponse(rawReply) || 'Namaste hajur, kehi technical samasya aayo. Kripaya feri prayas garnuhos.';
  
  await saveChatMessage(senderPsid, 'assistant', aiReply);

  return aiReply;
}

/**
 * Send text message via Meta Graph API
 */
async function sendTextMessage(senderPsid, responseText) {
  const requestBody = {
    recipient: { id: senderPsid },
    message: { text: responseText }
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.META_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
      const errData = await res.json();
      console.error('Error sending message via Meta API:', errData);
    } else {
      console.log(`✅ Response successfully sent to user (${senderPsid})`);
    }
  } catch (error) {
    console.error('Failed to send text message:', error);
  }
}

// Meta Webhook Verification
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

// Meta Webhook Event Handler
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      if (!entry.messaging) continue;

      for (const webhookEvent of entry.messaging) {
        const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
        if (!senderPsid) continue;

        if (webhookEvent.message && webhookEvent.message.text) {
          const userText = webhookEvent.message.text;
          console.log(`💬 Message received from ${senderPsid}: "${userText}"`);

          try {
            const aiReply = await processCustomerMessage(userText, senderPsid, 'himalayan_wear');
            console.log(`🤖 AI Reply: "${aiReply}"`);
            await sendTextMessage(senderPsid, aiReply);
          } catch (err) {
            console.error('❌ Error processing text message:', err);
          }
        } else if (webhookEvent.message && webhookEvent.message.attachments) {
          const imageAttachment = webhookEvent.message.attachments.find(att => att.type === 'image');
          
          if (imageAttachment && imageAttachment.payload && imageAttachment.payload.url) {
            const imageUrl = imageAttachment.payload.url;
            console.log(`🖼️ Image received from ${senderPsid}: ${imageUrl}`);

            try {
              const aiReply = await processCustomerImage(imageUrl, senderPsid, 'himalayan_wear');
              console.log(`🤖 AI Vision Reply: "${aiReply}"`);
              await sendTextMessage(senderPsid, aiReply);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});