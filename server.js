require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Deduplication cache to prevent Meta double-webhook executions
const processedMessageIds = new Set();

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

  // Remove surrounding quotation marks
  cleaned = cleaned.replace(/^["']|["']$/g, '');

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
 * Save chat message to Supabase to maintain multi-turn context
 */
async function saveChatMessage(senderPsid, role, content) {
  try {
    const { error } = await supabase.from('chat_messages').insert([
      { sender_psid: senderPsid, role, content }
    ]);
    if (error) console.error('Error saving chat message to Supabase:', error);
  } catch (err) {
    console.error('Error saving chat message:', err);
  }
}

/**
 * Fetch past chat messages for conversation history
 */
async function getChatHistory(senderPsid, limit = 8) {
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
 * Save customer order into Supabase and automatically deduct stock
 */
async function saveOrder({ customer_name, phone_number, delivery_location, product_title, quantity, total_price_npr, delivery_charge_npr, store_id = 'himalayan_wear' }) {
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

async function processCustomerImage(imageUrl, senderPsid, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);

  try {
    const imageResponse = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const visionPrompt = `
You are a polite customer assistant for "Himalayan Wear" in Kathmandu speaking natural Romanized Nepali.

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

    await saveChatMessage(senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(senderPsid, 'assistant', aiReply);

    return aiReply;
  } catch (err) {
    console.error('Vision API Error:', err);
    return 'Hajur, photo analyze garda kehi samasya aayo. Kripaya text ma lekhera sodhnuhos.';
  }
}

async function processCustomerMessage(userMessage, senderPsid, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);
  const chatHistory = await getChatHistory(senderPsid);

  const lowerMsg = userMessage.toLowerCase().trim();

  // Guardrail 1: Detect explicit order decline or delay keywords
  const orderDeclinedOrDelayed = lowerMsg.includes('paxi') || 
                                 lowerMsg.includes('pachi') || 
                                 lowerMsg.includes('ahile gardina') || 
                                 lowerMsg.includes('decide garera') || 
                                 lowerMsg.includes('haina pardaina') || 
                                 lowerMsg.includes('pardaina') || 
                                 lowerMsg.includes('nai');

  // Guardrail 2: Detect simple acknowledgement phrases
  const isSimpleAck = lowerMsg === 'huss' || lowerMsg === 'okay' || lowerMsg === 'ok' || lowerMsg === 'dhanyabad' || lowerMsg === 'thank you';

  // Check if an order was already confirmed in recent history
  const lastAssistantMsg = [...chatHistory].reverse().find(m => m.role === 'assistant');
  const isOrderAlreadyConfirmed = lastAssistantMsg && lastAssistantMsg.content.includes('confirm bhayo');

  // Disable tool calling if user declined, sent a simple ack, or order is already confirmed
  const shouldDisableTools = isOrderAlreadyConfirmed || orderDeclinedOrDelayed || isSimpleAck;

  const systemPrompt = `
You are a polite, natural, and helpful sales assistant for "Himalayan Wear" in Kathmandu, Nepal.

STORE LIVE INVENTORY:
${inventoryList}

STRICT GRAMMAR & LANGUAGE DIRECTIVES:
- Speak strictly in clear, natural Romanized Nepali (Aadarthi Bhasa).
- Maintain short, concise sentences (1-2 sentences maximum).
- FORBIDDEN WORDS/PHRASES: NEVER use "pasand", "pasand aaucha", "koi", "aur", "sath", "chahiye", "karne sakchu", "puchnu".
- MANDATORY PHRASING:
  * Greeting: "Namaste hajur! Himalayan Wear ma swagat chha. Aaja ke dekhaum?"
  * "Do you like this?": "Yo tapai lai mann parchha ki?"
  * "No problem": "Hajur, kehi pharak pardaina."
  * "Whenever you decide": "Hajur le decide garepachhi khabar garnuhola hai."

UPSELLING & REJECTION RULES:
1. If an item is NOT in stock, state it clearly: "Hajur, [item] ta aile stock ma chhaina."
2. You may suggest a similar item ONCE.
3. CRITICAL: If the customer insists on an out-of-stock item or color (e.g., "Haina red ma nai chahiyeko thyo") or declines an alternative ("Haina pardaina"), DO NOT PITCH ANY MORE PRODUCTS!
   - Reply gracefully: "Hajur, bujhe. Red color ma stock aune bittikai tapai lai khabar garnechhaum hai! Dhanyabad."

REQUEST TO SPEAK TO OWNER / MANAGER:
- If asked for owner/manager, reply:
  "Hajur, maile tapai ko message owner lai forward gardiyeko chhu. Unale chhitai tapai lai contact garnuhunechha hai!"
- NEVER invent or output fake phone numbers.

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
  await saveChatMessage(senderPsid, 'user', userMessage);

  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0 && !shouldDisableTools) {
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
        orderReply = 'Hajur, order confirm garda kehi samasya aayo. Kripaya full name ra phone number punah check garera pathaunu hola.';
      }

      await saveChatMessage(senderPsid, 'assistant', orderReply);
      return orderReply;
    }
  }

  const rawReply = responseMessage.content || '';
  const aiReply = cleanAiResponse(rawReply) || 'Hajur, kehi technical samasya aayo. Kripaya feri prayas garnuhos.';
  await saveChatMessage(senderPsid, 'assistant', aiReply);

  return aiReply;
}

async function sendTextMessage(senderPsid, responseText) {
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.META_ACCESS_TOKEN}`, {
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
      console.log(`✅ Response successfully sent to user (${senderPsid})`);
    }
  } catch (error) {
    console.error('Failed to send text message:', error);
  }
}

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

    for (const entry of body.entry) {
      let messagingEvents = entry.messaging || [];
      if (!entry.messaging && entry.changes) {
        messagingEvents = entry.changes.map(change => change.value).filter(val => val && val.message);
      }

      for (const webhookEvent of messagingEvents) {
        const messageId = webhookEvent.message ? webhookEvent.message.mid : null;

        if (messageId && processedMessageIds.has(messageId)) {
          console.log(`⚠️ Skipping duplicate message ID: ${messageId}`);
          continue;
        }

        if (messageId) {
          processedMessageIds.add(messageId);
          if (processedMessageIds.size > 1000) {
            const firstItem = processedMessageIds.values().next().value;
            processedMessageIds.delete(firstItem);
          }
        }

        const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
        if (!senderPsid || (webhookEvent.message && webhookEvent.message.is_echo)) continue;

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
        } 
        else if (webhookEvent.message && webhookEvent.message.attachments) {
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