require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Groq Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
    return 'No items currently in stock.';
  }

  return data
    .map(p => `- ${p.title}: NPR ${p.price_npr} (${p.stock_quantity} items in stock) [ID: ${p.id}]`)
    .join('\n');
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
 * Process customer message with AI function calling support
 */
async function processCustomerMessage(userMessage, storeId = 'himalayan_wear') {
  const inventoryList = await getStoreInventory(storeId);

  const systemPrompt = `
You are a polite, natural, and helpful AI sales assistant for "Himalayan Wear", an online apparel store in Nepal.
Your goal is to assist customers warmly, answer questions accurately, and guide them through placing orders.

Current Live Store Inventory:
${inventoryList}

Language & Tone Guidelines:
1. Speak in natural, fluent, everyday Romanized Nepali mixed with common English terms (e.g., "stock", "order", "delivery", "size", "exchange").
2. Maintain a warm, polite, and respectful tone using "Namaste", "Hajur", "Tapai", and "Dhanyabad".
3. Avoid literal, robotic English-to-Nepali translations. Speak like a friendly Nepali shop attendant on Messenger.

Store Policies & Handling Guidelines:
1. GENERAL GREETINGS ("hi", "hello", "namaste"): Greet warmly and ask what they are looking for without listing all inventory items.
2. PAYMENT METHODS: Cash on Delivery (COD), eSewa, Khalti, and Bank Transfer are accepted.
3. DELIVERY CHARGES: Inside Kathmandu Valley NPR 100 (1-2 days). Outside Kathmandu Valley NPR 200 (3-4 days).
4. PHYSICAL LOCATION: Purely an online store delivering across Nepal.
5. RETURN & EXCHANGE POLICY: Exchange available within 7 days for size issues/defects. No cash refunds.
6. SIZING ASSISTANCE: Ask for height and weight to suggest size.
7. STOCK INQUIRIES: Provide item list only when explicitly asked.
8. ORDER PLACEMENT & TOOL CALLING: When Full Name, Phone, Address, and Product Title are provided, invoke 'saveOrder'. Strictly output valid JSON parameters. Do NOT use XML or HTML tags.
`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  const response = await groq.chat.completions.create({
    messages,
    model: 'llama-3.3-70b-versatile',
    tools: [orderTool],
    tool_choice: 'auto'
  });

  const responseMessage = response.choices[0]?.message;

  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    const toolCall = responseMessage.tool_calls[0];
    if (toolCall.function.name === 'saveOrder') {
      const orderArgs = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;

      orderArgs.store_id = storeId;
      const orderResult = await saveOrder(orderArgs);

      if (orderResult.success) {
        return `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order (Order ID: #${orderResult.order.id}) successfully confirm bhayo. Hami jaldi nai ${orderArgs.phone_number} ma call garera delivery confirmation garnechha.`;
      } else {
        return 'Hajur, order confirm garda kehi technical samasya aayo. Kripaya punah prayas garnuhos.';
      }
    }
  }

  return responseMessage.content || 'Hajur, kehi technical samasya aayo. Kripaya feri prayas garnuhos.';
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

// Meta Webhook Routes
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

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      if (!entry.messaging) continue;

      for (const webhookEvent of entry.messaging) {
        const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;

        if (webhookEvent.message && webhookEvent.message.text && senderPsid) {
          const userText = webhookEvent.message.text;
          console.log(`💬 Message received from ${senderPsid}: "${userText}"`);

          try {
            const aiReply = await processCustomerMessage(userText, 'himalayan_wear');
            console.log(`🤖 AI Reply: "${aiReply}"`);
            await sendTextMessage(senderPsid, aiReply);
          } catch (err) {
            console.error('❌ Error processing message:', err);
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