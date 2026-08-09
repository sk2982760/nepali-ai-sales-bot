require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// Initialize Clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
async function getChatHistory(senderPsid, limit = 6) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('sender_psid', senderPsid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  // Return in chronological order
  return data.reverse().map(msg => ({ role: msg.role, content: msg.content }));
}

/**
 * Save customer order into Supabase and automatically deduct stock
 */
async function saveOrder({ customer_name, phone_number, delivery_location, product_title, quantity, total_price_npr, delivery_charge_npr, store_id = 'himalayan_wear' }) {
  const orderQuantity = quantity || 1;

  // 1. Save the Order
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

  // 2. Deduct Stock from Products Table
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

// Define tool for Groq function calling
const orderTool = {
  type: 'function',
  function: {
    name: 'saveOrder',
    description: 'Save a customer order when full name, phone number, location, product title, and totals are provided.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Full name of the customer' },
        phone_number: { type: 'string', description: 'Phone number of the customer' },
        delivery_location: { type: 'string', description: 'Detailed delivery address or city' },
        product_title: { type: 'string', description: 'Exact product title ordered' },
        quantity: { type: 'integer', description: 'Quantity ordered (default 1)' },
        total_price_npr: { type: 'number', description: 'Total item cost in NPR (excluding delivery fee)' },
        delivery_charge_npr: { type: 'number', description: 'Delivery fee in NPR (100 for Inside Valley, 200 for Outside Valley)' }
      },
      required: ['customer_name', 'phone_number', 'delivery_location', 'product_title', 'total_price_npr', 'delivery_charge_npr']
    }
  }
};

/**
 * Handle incoming image attachments using Google Gemini 1.5 Flash Vision
 */
async function processCustomerImage(imageUrl, senderPsid, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);

  try {
    // 1. Download image from Meta CDN
    const imageResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image from Meta CDN: ${imageResponse.statusText}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

    const visionPrompt = `
You are analyzing a photo sent by a customer to an online apparel store "Himalayan Wear" in Nepal.

CURRENT STORE INVENTORY:
${inventoryList}

TASK:
1. Identify the item in the image (color, clothing type, style).
2. Compare it with the live store inventory listed above.
3. Respond ONLY in polite, natural Romanized Nepali.
4. If we sell this item or something similar, tell the customer it's available along with its exact price and stock.
5. If we don't carry this exact color/item, politely inform them what similar items we have in stock.
6. DO NOT include any English explanations in brackets or parentheses.
`;

    // 2. Process image with Gemini 1.5 Flash
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent([
      visionPrompt,
      {
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      }
    ]);

    const aiReply = result.response.text() || 'Hajur, photo clear dekhiyana. Kripaya punah photo pathaunu hola.';
    
    await saveChatMessage(senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(senderPsid, 'assistant', aiReply);

    return aiReply;
  } catch (err) {
    console.error('Vision API Error:', err.message || err);

    const fallbackReply = 'Hajur, photo analyze garda kehi technical samasya aayo. Kripaya item ko naam text ma lekhera sodhnuhos!';

    await saveChatMessage(senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(senderPsid, 'assistant', fallbackReply);

    return fallbackReply;
  }
}

/**
 * Process customer text message with AI function calling and context history
 */
async function processCustomerMessage(userMessage, senderPsid, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);
  const chatHistory = await getChatHistory(senderPsid);

  const systemPrompt = `
You are a sales assistant for "Himalayan Wear", an online clothing store in Nepal.

CURRENT LIVE INVENTORY:
${inventoryList}

STRICT OUTPUT RULES (FAILURE TO FOLLOW THESE IS AN ERROR):
1. Respond ONLY in natural Romanized Nepali (Nepali written in English script).
2. DO NOT write any English sentences or explanations.
3. DO NOT include English translations in brackets or parentheses like "(Hello! How can I help you?)".
4. Speak like a polite Nepali shopkeeper on Messenger using "Namaste", "Hajur", "Tapai", "Cha", "Chaina".

EXACT RESPONSE EXAMPLES:

User: "hi" or "hello"
Reply: "Namaste hajur! Himalayan Wear ma swagat chha. Hami hjr ko k sewa garna sakxau?"

User: "shoes available cha?"
Reply: "Hajur, hamro ma shoes ta available chaina. Hamro ma Hoodies, Graphic Tees, ra Pants haru stock ma chha."

User: "delivery charge kati ho?"
Reply: "Delivery charge Kathmandu valley bhittra Rs 100 ra valley bahira Rs 200 parchha hajur."

User: "black hoodie ko price"
Reply: "Hajur, Oversized Black Hoodie ko price Rs 1800 ho. Stock ma available chha. Tapai lai k size chahiyako thiyo?"
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

  // Save user message to database
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

  const aiReply = responseMessage.content || 'Hajur, kehi technical samasya aayo. Kripaya feri prayas garnuhos.';
  await saveChatMessage(senderPsid, 'assistant', aiReply);

  return aiReply;
}

/**
 * Helper function to send messages back to Meta Graph API
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

// Meta Webhook Verification Route
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

// Meta Webhook Event Processing
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      if (!entry.messaging) continue;

      for (const webhookEvent of entry.messaging) {
        const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;
        if (!senderPsid) continue;

        // Process Text Message
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
        // Process Image Attachment
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