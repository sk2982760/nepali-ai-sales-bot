// whatsappWebhook.js
const express = require('express');
const router = express.Router();
const { sendWhatsAppMessage, getWhatsAppMediaUrl } = require('./whatsappService');

// NOTE: Import your existing engine services here
// const { processCustomerMessage } = require('./aiEngine'); 

/**
 * 1. Meta Webhook Verification Handshake
 */
router.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WhatsApp Webhook] Verified successfully.');
    return res.status(200).send(challenge);
  }
  
  return res.sendStatus(403);
});

/**
 * 2. Handle Incoming WhatsApp Events
 */
router.post('/webhook/whatsapp', async (req, res) => {
  // Always return 200 OK immediately to acknowledge receipt to Meta
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Ignore status updates (e.g., delivered, read receipts)
    if (!message) return;

    const customerPhone = message.from; // Sender phone number
    const messageType = message.type;
    
    let userText = '';
    let imageUrl = null;

    if (messageType === 'text') {
      userText = message.text.body;
    } else if (messageType === 'image') {
      userText = message.image.caption || 'Looking for this product image';
      imageUrl = await getWhatsAppMediaUrl(message.image.id);
    } else {
      // Ignore unsupported media (voice notes, stickers, etc.)
      return;
    }

    console.log(`[WhatsApp] Message from ${customerPhone}: "${userText}"`);

    // Run message through your unified Sales Engine pipeline
    // Example call to existing logic:
    // const aiReply = await processCustomerMessage({
    //   channel: 'whatsapp',
    //   userId: customerPhone,
    //   text: userText,
    //   imageUrl: imageUrl
    // });

    // Mock response demonstration:
    const aiReply = "Namaste! Saugat Handicrafts ma swagat chha. Tapailai k product herna man chha?";

    // Send AI generated response back via WhatsApp
    await sendWhatsAppMessage(customerPhone, aiReply);

  } catch (error) {
    console.error('[WhatsApp Webhook Error]:', error);
  }
});

module.exports = router;