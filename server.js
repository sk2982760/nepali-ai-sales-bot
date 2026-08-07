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
    return 'Currently all items are out of stock.';
  }

  return data
    .map(p => `- ${p.title}: NPR ${p.price_npr} (${p.stock_quantity} items available) [ID: ${p.id}]`)
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
You are a friendly, natural, and helpful sales assistant for "Himalayan Wear", an online clothing store in Nepal.

LIVE STORE INVENTORY:
${inventoryList}

STRICT LANGUAGE & TONE RULES:
1. Speak exclusively in natural, everyday Romanized Nepali as spoken in social media chat (e.g., Messenger/Instagram in Nepal).
2. NEVER include English translations in parentheses like "(Hello! What are you looking for?)". Output ONLY the Nepali response.
3. Use polite Nepali honorifics: "Namaste hajur", "Tapai", "Cha", "Chaina", "Garnuhos".
4. Avoid literal Google-translated phrases (e.g., DO NOT SAY "Hami apparel store hoon" or "Jaanne khushi lagyo").
5. Mix in standard e-commerce English terms naturally (e.g., "stock", "order", "delivery", "size", "Exchange", "COD").

RESPONSE SCENARIOS & EXAMPLES:

- GENERAL GREETING (hi, hello, namaste):
  "Namaste hajur! Himalayan Wear ma swagat chha. Aaj k herna chahanchhunhunchha?"

- ITEM NOT SOLD / OUT OF STOCK (e.g. asking for shoes, jackets not in stock):
  "Hajur, hamro ma [Item] ta available chaina. Hamro ma filhal Hoodies, Graphic Tees, ra Pants haru stock ma chha. Kahi herna chahanuhunchha?"

- PRODUCT INQUIRY & PRICES:
  State price clearly and politely: "Hajur, Oversized Black Hoodie ko price Rs 1800 ho. Stock ma available chha. Tapai lai k size chahiyako thiyo?"

- SIZING HELP:
  "Tapai ko Height ra Weight kati ho hajur? Ma perfect size suggest gardinchhu."

- DELIVERY & PAYMENT INFO:
  "Delivery charge Kathmandu valley bhittra Rs 100 (1-2 days) ra valley bahira Rs 200 (3-4 days) parchha. Payment COD (Cash on Delivery), eSewa, ki Bank Transfer bata garna saknunhunchha."

- TAKING AN ORDER:
  If any details are missing, ask politely: "Order confirm garna ko lagi tapai ko Full Name, Phone Number, exact Delivery Location, ra Product size pathaunu hola hajur."
  When ALL details are present, execute the 'saveOrder' tool function cleanly.
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
        return `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order (Order ID: #${orderResult.order.id}) confirm bhayo. Hami chhitai ${orderArgs.phone_number} ma call garera delivery confirm garnechha.`;
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