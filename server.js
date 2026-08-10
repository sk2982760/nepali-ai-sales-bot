require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// BASIC SETUP & DEDUPLICATION
// ---------------------------------------------------------

const processedMessageIds = new Set();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ---------------------------------------------------------
// RESPONSE CLEANING
// ---------------------------------------------------------

function cleanAiResponse(text) {
  if (!text) return '';

  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (cleaned.length > 1900) {
    cleaned = cleaned.substring(0, 1900).trim() + '...';
  }

  return cleaned;
}

// ---------------------------------------------------------
// LANGUAGE & PRODUCT NORMALIZATION
// ---------------------------------------------------------

function normalizeText(text = '') {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRODUCT_ALIASES = {
  tshirt: ['tshirt', 't-shirt', 'tee', 'tees', 't shirt'],
  shirt: ['shirt', 'shirts'],
  pant: ['pant', 'pants', 'trouser', 'trousers', 'pantaloon'],
  jeans: ['jeans', 'jean'],
  hoodie: ['hoodie', 'hoodies'],
  jacket: ['jacket', 'jackets'],
  sweatshirt: ['sweatshirt', 'sweatshirts'],
  shorts: ['shorts', 'short'],
  trouser: ['trouser', 'trousers', 'pant', 'pants'],
  top: ['top', 'tops'],
  kurta: ['kurta', 'kurtas'],
  dress: ['dress', 'dresses'],
  skirt: ['skirt', 'skirts']
};

const COLOR_ALIASES = {
  red: ['red', 'raatop', 'rato', 'lal'],
  blue: ['blue', 'nilo', 'neelo'],
  black: ['black', 'kalo'],
  white: ['white', 'seto', 'seeto'],
  green: ['green', 'hariyo', 'hario'],
  yellow: ['yellow', 'pahelo'],
  pink: ['pink', 'gulabi'],
  grey: ['grey', 'gray', 'khairo'],
  brown: ['brown', 'khaire', 'khairo'],
  maroon: ['maroon'],
  navy: ['navy'],
  beige: ['beige'],
  cream: ['cream']
};

function expandSearchTokens(text) {
  const normalized = normalizeText(text);
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));

  for (const [canonical, aliases] of Object.entries(PRODUCT_ALIASES)) {
    if (aliases.some(alias => normalized.includes(alias))) {
      tokens.add(canonical);
    }
  }

  for (const [canonical, aliases] of Object.entries(COLOR_ALIASES)) {
    if (aliases.some(alias => normalized.includes(alias))) {
      tokens.add(canonical);
    }
  }

  return tokens;
}

function getDetectedCategories(text) {
  const normalized = normalizeText(text);
  const categories = new Set();

  for (const [canonical, aliases] of Object.entries(PRODUCT_ALIASES)) {
    if (aliases.some(alias => normalized.includes(alias))) {
      categories.add(canonical);
    }
  }

  if (categories.has('pant') || categories.has('trouser')) {
    categories.add('pant');
    categories.add('trouser');
  }

  return categories;
}

function getDetectedColors(text) {
  const normalized = normalizeText(text);
  const colors = new Set();

  for (const [canonical, aliases] of Object.entries(COLOR_ALIASES)) {
    if (aliases.some(alias => normalized.includes(alias))) {
      colors.add(canonical);
    }
  }

  return colors;
}

// Deterministic product matching to restrict LLM suggestions
function findRelevantProducts(userMessage, chatHistory, inventory) {
  const recentUserMessages = chatHistory
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => m.content)
    .filter(Boolean);

  const searchText = [...recentUserMessages, userMessage].join(' ');

  const queryTokens = expandSearchTokens(searchText);
  const queryCategories = getDetectedCategories(searchText);
  const queryColors = getDetectedColors(searchText);

  const scored = inventory.map(product => {
    const title = normalizeText(product.title || '');
    const titleTokens = expandSearchTokens(title);

    let score = 0;

    const normalizedCurrent = normalizeText(userMessage);
    if (normalizedCurrent && title.includes(normalizedCurrent)) {
      score += 100;
    }

    const productCategories = getDetectedCategories(title);
    for (const category of queryCategories) {
      if (productCategories.has(category)) {
        score += 35;
      }
    }

    const productColors = getDetectedColors(title);
    for (const color of queryColors) {
      if (productColors.has(color)) {
        score += 30;
      }
    }

    for (const token of queryTokens) {
      if (token.length >= 3 && titleTokens.has(token)) {
        score += 8;
      }
    }

    const rawQueryWords = normalizeText(searchText)
      .split(/\s+/)
      .filter(w => w.length >= 4);

    for (const word of rawQueryWords) {
      if (title.includes(word)) {
        score += 4;
      }
    }

    if (queryCategories.size > 0) {
      const categoryMatched = [...queryCategories].some(c =>
        productCategories.has(c)
      );

      if (!categoryMatched) {
        score -= 80;
      }
    }

    if (queryColors.size > 0 && productColors.size > 0) {
      const colorMatched = [...queryColors].some(c =>
        productColors.has(c)
      );

      if (!colorMatched) {
        score -= 60;
      }
    }

    return {
      ...product,
      relevance_score: score
    };
  });

  return scored
    .filter(p => p.relevance_score >= 20)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 6);
}

// ---------------------------------------------------------
// INVENTORY FUNCTIONS
// ---------------------------------------------------------

async function getStoreInventory(storeId = 'himalayan_wear') {
  const { data, error } = await supabase
    .from('products')
    .select('id, title, price_npr, stock_quantity')
    .eq('store_id', storeId)
    .gt('stock_quantity', 0);

  if (error) {
    console.error('Error fetching products from Supabase:', error);
    return [];
  }

  return data || [];
}

function formatProducts(products) {
  if (!products || products.length === 0) {
    return '[]';
  }

  return JSON.stringify(
    products.map(p => ({
      id: p.id,
      title: p.title,
      price_npr: p.price_npr,
      stock_quantity: p.stock_quantity
    })),
    null,
    2
  );
}

// ---------------------------------------------------------
// CHAT HISTORY DATABASE FUNCTIONS
// ---------------------------------------------------------

async function saveChatMessage(senderPsid, role, content) {
  try {
    const { error } = await supabase
      .from('chat_messages')
      .insert([{ sender_psid: senderPsid, role, content }]);

    if (error) {
      console.error('Error saving chat message to Supabase:', error);
    }
  } catch (err) {
    console.error('Error saving chat message:', err);
  }
}

async function getChatHistory(senderPsid, limit = 10) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('sender_psid', senderPsid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    return [];
  }

  return data.reverse().map(msg => ({
    role: msg.role,
    content: msg.content
  }));
}

// ---------------------------------------------------------
// INTENT DETECTION
// ---------------------------------------------------------

function detectIntent(userMessage, chatHistory = []) {
  const text = normalizeText(userMessage);

  if (
    /\b(owner|manager|sanchalak|malik|malik lai|owner lai)\b/i.test(text) ||
    text.includes('owner sanga') ||
    text.includes('manager sanga')
  ) {
    return 'human';
  }

  if (
    text === 'huss' ||
    text === 'ok' ||
    text === 'okay' ||
    text === 'thik cha' ||
    text === 'la thik cha' ||
    text === 'dhanyabad' ||
    text === 'thank you' ||
    text === 'thanks'
  ) {
    return 'acknowledgement';
  }

  if (
    text.includes('order gar') ||
    text.includes('order din') ||
    text.includes('lina man') ||
    text.includes('linchu') ||
    text.includes('confirm gar') ||
    text.includes('book gar')
  ) {
    return 'order';
  }

  if (
    text.includes('delivery') ||
    text.includes('deliver') ||
    text.includes('shipping') ||
    text.includes('charge') ||
    text.includes('kati lincha')
  ) {
    return 'delivery';
  }

  if (
    text.includes('price') ||
    text.includes('kati ho') ||
    text.includes('kati parcha') ||
    text.includes('kati parchha') ||
    text.includes('rupiya') ||
    text.includes('npr')
  ) {
    return 'price';
  }

  if (
    text.includes('size') ||
    /\b(xs|s|m|l|xl|xxl|xxxl)\b/i.test(text)
  ) {
    return 'size';
  }

  if (
    text.includes('cha?') ||
    text.includes('chha?') ||
    text.includes('available') ||
    text.includes('stock') ||
    text.includes('pauxa') ||
    text.includes('paaincha') ||
    text.includes('paincha')
  ) {
    return 'availability';
  }

  if (
    text.includes('namaste') ||
    text === 'hi' ||
    text === 'hello' ||
    text === 'hajur'
  ) {
    return 'greeting';
  }

  const hasProductContext = chatHistory.some(
    m =>
      m.role === 'user' &&
      getDetectedCategories(m.content).size > 0
  );

  if (
    getDetectedCategories(userMessage).size > 0 ||
    getDetectedColors(userMessage).size > 0 ||
    hasProductContext
  ) {
    return 'product';
  }

  return 'general';
}

// ---------------------------------------------------------
// ORDER TOOL DEFINITION
// ---------------------------------------------------------

const orderTool = {
  type: 'function',
  function: {
    name: 'saveOrder',
    description:
      'Save an order ONLY when the customer explicitly wants to place/confirm the order NOW and the CURRENT customer message contains complete Name, Phone Number, Delivery Address, Product and Quantity. Never call this for a general question, acknowledgement, future intention, or missing details.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: {
          type: 'string',
          description: 'Full customer name from the CURRENT message'
        },
        phone_number: {
          type: 'string',
          description: 'Customer phone number from the CURRENT message'
        },
        delivery_location: {
          type: 'string',
          description: 'Delivery address from the CURRENT message'
        },
        product_title: {
          type: 'string',
          description: 'Exact title of the product being ordered. Must be one of the relevant inventory products supplied in the prompt.'
        },
        quantity: {
          type: 'integer',
          description: 'Quantity ordered. Default 1.'
        },
        total_price_npr: {
          type: 'number',
          description: 'Total item price in NPR'
        },
        delivery_charge_npr: {
          type: 'number',
          description: 'Delivery fee in NPR. Use 100 for Inside Valley and 200 for Outside Valley.'
        }
      },
      required: [
        'customer_name',
        'phone_number',
        'delivery_location',
        'product_title',
        'total_price_npr',
        'delivery_charge_npr'
      ]
    }
  }
};

// ---------------------------------------------------------
// ORDER SAVE LOGIC
// ---------------------------------------------------------

async function saveOrder({
  customer_name,
  phone_number,
  delivery_location,
  product_title,
  quantity,
  total_price_npr,
  delivery_charge_npr,
  store_id = 'himalayan_wear'
}) {
  const orderQuantity = quantity || 1;

  if (
    !customer_name ||
    !phone_number ||
    !delivery_location ||
    !product_title
  ) {
    return {
      success: false,
      error: 'Incomplete user details provided.'
    };
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
    return {
      success: false,
      error: orderError.message
    };
  }

  const { data: prodData } = await supabase
    .from('products')
    .select('id, stock_quantity')
    .eq('store_id', store_id)
    .ilike('title', `%${product_title}%`)
    .limit(1)
    .maybeSingle();

  if (prodData) {
    const newStock = Math.max(
      0,
      prodData.stock_quantity - orderQuantity
    );

    await supabase
      .from('products')
      .update({ stock_quantity: newStock })
      .eq('id', prodData.id);
  }

  return {
    success: true,
    order: orderData[0]
  };
}

// ---------------------------------------------------------
// IMAGE / VISION PROCESSING
// ---------------------------------------------------------

async function processCustomerImage(
  imageUrl,
  senderPsid,
  storeId = 'himalayan_wear'
) {
  const inventory = await getStoreInventory(storeId);

  try {
    const imageResponse = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const mimeType =
      imageResponse.headers.get('content-type') || 'image/jpeg';

    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const visionPrompt = `
You are the sales assistant of Himalayan Wear in Kathmandu, Nepal.

Your job is to understand the clothing item shown in the customer's photo and reply in natural, polite Romanized Nepali.

AVAILABLE PRODUCTS:
${formatProducts(inventory)}

STRICT RULES:
1. Reply in natural Romanized Nepali. Do not use Hindi-style wording.
2. Be polite and human. Use "hajur" naturally, not in every sentence.
3. Do NOT invent a product, price, color, size, or stock.
4. If the photo appears to match a product in AVAILABLE PRODUCTS, use only that product's actual title and price.
5. If there is no clear matching product, say that the exact item is not currently found in the available stock.
6. Never suggest a different clothing category just to keep the conversation going.
7. Keep the reply to 1-2 short sentences.
8. Do not use words such as "aur", "sath", "koi", or Hindi-style "chahiye".
9. Natural examples:
   - "Hajur, yo design hamro stock ma chha. Price NPR 1200 ho."
   - "Hajur, photo ma dekhiyeko exact design aile hamro stock ma bhetiyena."
`;

    const visionResponse = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPrompt },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ],
      temperature: 0.1
    });

    const rawReply =
      visionResponse.choices[0]?.message?.content || '';

    const aiReply =
      cleanAiResponse(rawReply) ||
      'Hajur, photo bata item clear rupma chinna sakiyena. Kripaya product ko naam wa photo feri pathaunu hola.';

    await saveChatMessage(senderPsid, 'user', '[Sent an image]');
    await saveChatMessage(senderPsid, 'assistant', aiReply);

    return aiReply;
  } catch (err) {
    console.error('Vision API Error:', err);
    return 'Hajur, photo herda kehi samasya aayo. Kripaya product ko naam wa photo feri pathaunu hola.';
  }
}

// ---------------------------------------------------------
// MAIN CUSTOMER MESSAGE PROCESSOR
// ---------------------------------------------------------

async function processCustomerMessage(
  userMessage,
  senderPsid,
  storeId = 'himalayan_wear'
) {
  const inventory = await getStoreInventory(storeId);
  const chatHistory = await getChatHistory(senderPsid, 10);

  const lowerMsg = normalizeText(userMessage);

  // Deterministic guardrails
  const orderDeclinedOrDelayed =
    lowerMsg.includes('paxi') ||
    lowerMsg.includes('pachi') ||
    lowerMsg.includes('ahile gardina') ||
    lowerMsg.includes('ahile lina') ||
    lowerMsg.includes('decide garera') ||
    lowerMsg === 'no' ||
    lowerMsg === 'nai';

  const isSimpleAck =
    lowerMsg === 'huss' ||
    lowerMsg === 'okay' ||
    lowerMsg === 'ok' ||
    lowerMsg === 'thik cha' ||
    lowerMsg === 'la thik cha' ||
    lowerMsg === 'dhanyabad' ||
    lowerMsg === 'thank you' ||
    lowerMsg === 'thanks';

  const lastAssistantMsg = [...chatHistory]
    .reverse()
    .find(m => m.role === 'assistant');

  const isOrderAlreadyConfirmed =
    lastAssistantMsg &&
    /order.*confirm bhayo/i.test(lastAssistantMsg.content);

  const intent = detectIntent(userMessage, chatHistory);

  const relevantProducts = findRelevantProducts(
    userMessage,
    chatHistory,
    inventory
  );

  const productQuestionIntents = new Set([
    'product',
    'availability',
    'price',
    'size'
  ]);

  const isProductQuestion = productQuestionIntents.has(intent);

  const productContext = isProductQuestion
    ? formatProducts(relevantProducts)
    : 'Product lookup not required for this message.';

  const noRelevantProduct =
    isProductQuestion && relevantProducts.length === 0;

  const shouldDisableTools =
    isOrderAlreadyConfirmed ||
    orderDeclinedOrDelayed ||
    isSimpleAck ||
    intent !== 'order';

  const systemPrompt = `
You are the sales assistant for "Himalayan Wear", a clothing store in Kathmandu, Nepal.

Your job is to reply to customers as if you are a real Nepali clothing seller.

==================================================
LANGUAGE
==================================================

Write in natural Romanized Nepali.

The response must sound like a Nepali seller talking politely to a customer, NOT like a translated Hindi sentence and NOT like an AI.

Use natural words such as:
- "hajur"
- "tapai"
- "chha"
- "chaina"
- "pauchha"
- "bhetinchha"
- "hernu hola"
- "pathaunu hola"
- "garnuhola"

Do NOT force "hajur" into every sentence.

Avoid Hindi-style wording such as:
- "aur"
- "sath"
- "koi"
- "chahiye"
- "karne sakchu"
- "puchnu"
- "tarik"

Do not translate English word-by-word into awkward Nepali.

Romanized Nepali examples:
- "Hajur, yo shirt aile stock ma chha. Price NPR 1200 ho."
- "Hajur, red color ko yo design aile available chaina."
- "M size chha hajur. L size pani cha ki herera bhandinchu."
- "Order garnuhunchha bhane name, phone number ra address pathaunu hola."
- "Hajur, thik cha. Tapai le decide garepachhi khabar garnuhola."

==================================================
VERY IMPORTANT: PRODUCT RELEVANCE
==================================================

The customer may ask for a specific product, color, category, or design.

NEVER recommend a product from a different category just because it is available.

Examples:
- Customer asks "red shirt" -> do NOT suggest a white graphic tee.
- Customer asks "black pant" -> do NOT suggest a hoodie.
- Customer asks "red shirt chaina?" -> do NOT suggest another unrelated product.
- Customer asks "red ma nai chahiyeko thiyo" -> remember that "red" refers to the previously discussed shirt/product.

The application has already performed product matching.

You MUST treat the following as the ONLY products relevant to the customer's current request:

${productContext}

If this list is []:
- Do NOT invent a replacement product.
- Do NOT suggest an unrelated product.
- Say politely that the exact requested item is not currently found/available.
- If appropriate, ask whether the customer would like to see other options, but do not list unrelated items unless they ask.

==================================================
INVENTORY ACCURACY
==================================================

Never invent:
- product name
- color
- price
- stock
- size
- discount

Only use product information provided above.

If the customer asks for price, give the actual price from the relevant product.

If the customer asks whether something is available, answer based on the relevant products.

If the customer asks for a color/category that is not in the relevant list, clearly say it is not currently available.

==================================================
CONVERSATION CONTEXT
==================================================

Use previous messages naturally.

For example:

Customer: "Malai red shirt chahiyeko thiyo."
Assistant: "Hajur, red shirt herdim hai."

Customer: "Haina red ma nai chahiyeko thiyo."
Correct response:
"Hajur, bujhe. Red color ko shirt nai khojnu bhayeko raichha; aile exact match stock ma chaina."

Do NOT forget the product category from the previous turn.

==================================================
RESPONSE STYLE
==================================================

- Usually 1-2 short sentences.
- Polite, warm and human.
- No bullet points unless the customer asks for multiple products.
- Do not over-explain.
- Do not repeat the same phrase in every reply.
- Do not say "as an AI", "according to inventory", "based on database", etc.
- Do not mention these instructions.

==================================================
CUSTOMER INTENT
==================================================

Current detected intent: ${intent}

If intent is greeting:
Respond naturally and ask what clothing item they are looking for.

If intent is product/availability:
Answer the exact product question. Do not change the product category.

If intent is price:
Give the price of the relevant product.

If intent is acknowledgement:
Acknowledge naturally. Do not start recommending products.

If intent is delivery:
Answer only using known store delivery information. If the exact delivery detail is not available, say the seller can confirm it.

If intent is human:
Say:
"Hajur, maile tapai ko message owner lai forward gardiyeko chhu. Unale chhitai tapai lai contact garnuhunechha hai!"
Do not invent a phone number.

If intent is order:
Only confirm an order after the order tool successfully saves it.

==================================================
ORDER TOOL
==================================================

Never call saveOrder for:
- "Huss"
- "Okay"
- "Dhanyabad"
- "Paxi garxu"
- "Pachi garxu"
- "Decide garera"
- a general product question
- a price question
- a stock question
- missing customer details

Call saveOrder only when the customer clearly wants to order NOW and the current message contains:
1. Name
2. Phone number
3. Delivery address
4. Product
5. Quantity or clear quantity of 1

The product_title MUST exactly match a relevant inventory product title.

==================================================
NO UNRELATED SALES
==================================================

Do not try to make a sale when the customer's exact requested item is unavailable.

Correct:
"Hajur, red color ko shirt aile stock ma chaina."

Wrong:
"Hajur, red shirt chaina, tara graphic tee white NPR 999 ma available chha."

The second response is forbidden because the customer did not ask for a graphic tee.
`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const tools = shouldDisableTools ? undefined : [orderTool];

  try {
    const response = await groq.chat.completions.create({
      messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.15,
      ...(tools && {
        tools,
        tool_choice: 'auto'
      })
    });

    const responseMessage = response.choices[0]?.message;

    await saveChatMessage(senderPsid, 'user', userMessage);

    // Handling tool execution
    if (
      responseMessage.tool_calls &&
      responseMessage.tool_calls.length > 0 &&
      !shouldDisableTools
    ) {
      const toolCall = responseMessage.tool_calls[0];

      if (toolCall.function.name === 'saveOrder') {
        let orderArgs;

        try {
          orderArgs =
            typeof toolCall.function.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments;
        } catch (parseError) {
          console.error('Order tool JSON parse error:', parseError);

          const errorReply =
            'Hajur, order details confirm garda kehi samasya aayo. Kripaya name, phone number ra address feri pathaunu hola.';

          await saveChatMessage(senderPsid, 'assistant', errorReply);
          return errorReply;
        }

        orderArgs.store_id = storeId;

        const matchedProduct = relevantProducts.find(
          p => normalizeText(p.title) === normalizeText(orderArgs.product_title)
        );

        if (!matchedProduct) {
          const invalidProductReply =
            'Hajur, tapai le bhannubhayeko exact product confirm garna sakiena. Kripaya product ko naam wa photo pathaunu hola.';

          await saveChatMessage(senderPsid, 'assistant', invalidProductReply);
          return invalidProductReply;
        }

        orderArgs.product_title = matchedProduct.title;
        orderArgs.total_price_npr =
          Number(matchedProduct.price_npr) * Number(orderArgs.quantity || 1);

        const orderResult = await saveOrder(orderArgs);

        let orderReply = '';
        if (orderResult.success) {
          orderReply = `Dhanyabad ${orderArgs.customer_name} hajur! Tapai ko order #${orderResult.order.id} confirm bhayo. Hami chhitai ${orderArgs.phone_number} ma call garera delivery confirm garnechhau.`;
        } else {
          orderReply =
            'Hajur, order confirm garda kehi samasya aayo. Kripaya name, phone number ra address feri check garera pathaunu hola.';
        }

        await saveChatMessage(senderPsid, 'assistant', orderReply);
        return orderReply;
      }
    }

    // Normal Text Response handling
    let rawReply = responseMessage.content || '';
    let aiReply = cleanAiResponse(rawReply);

    // Hard fallback if deterministic search found zero relevant products
    if (noRelevantProduct) {
      const requestedColors = [...getDetectedColors(userMessage)];
      const requestedCategories = [
        ...getDetectedCategories(
          [...chatHistory, { role: 'user', content: userMessage }]
            .filter(m => m.role === 'user')
            .map(m => m.content)
            .join(' ')
        )
      ];

      let requestedThing = '';

      if (requestedColors.length && requestedCategories.length) {
        requestedThing = `${requestedColors[0]} ${requestedCategories[0]}`;
      } else if (requestedCategories.length) {
        requestedThing = requestedCategories[0];
      } else if (requestedColors.length) {
        requestedThing = `${requestedColors[0]} color ko item`;
      } else {
        requestedThing = 'tapai le khojnu bhayeko item';
      }

      aiReply = `Hajur, ${requestedThing} aile hamro stock ma bhetiyena.`;
    }

    if (!aiReply) {
      aiReply = 'Hajur, kehi samasya aayo. Kripaya feri sodhnuhola.';
    }

    await saveChatMessage(senderPsid, 'assistant', aiReply);
    return aiReply;
  } catch (err) {
    console.error('Groq processing error:', err);

    const fallback =
      'Hajur, aile message process garda kehi samasya aayo. Kripaya feri sodhnuhola.';

    await saveChatMessage(senderPsid, 'user', userMessage);
    await saveChatMessage(senderPsid, 'assistant', fallback);

    return fallback;
  }
}

// ---------------------------------------------------------
// META SEND MESSAGE API
// ---------------------------------------------------------

async function sendTextMessage(senderPsid, responseText) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.META_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: senderPsid },
          message: { text: responseText }
        })
      }
    );

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

// ---------------------------------------------------------
// META WEBHOOK ENDPOINTS
// ---------------------------------------------------------

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

// ---------------------------------------------------------
// SERVER INITIALIZATION
// ---------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});