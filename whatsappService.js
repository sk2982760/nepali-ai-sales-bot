// whatsappService.js
const axios = require('axios');

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

/**
 * Send a plain text message via WhatsApp Cloud API
 */
async function sendWhatsAppMessage(to, text) {
  try {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to, // Format: e.g. "97798XXXXXXXX"
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

/**
 * Download incoming WhatsApp media (photos) to buffer/URL for vision search
 */
async function getWhatsAppMediaUrl(mediaId) {
  try {
    // 1. Get media URL
    const mediaRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    return mediaRes.data.url;
  } catch (error) {
    console.error('Failed to get WhatsApp media URL:', error.message);
    return null;
  }
}

module.exports = { sendWhatsAppMessage, getWhatsAppMediaUrl };