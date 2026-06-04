const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;

async function sendNotification(externalUserId, title, body, data = {}) {
  const response = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_aliases: { external_id: [externalUserId] },
      target_channel: 'push',
      headings: { en: title },
      contents: { en: body },
      data,
    }),
  });
  return response.json();
}

// Approved
app.post('/notify/approved', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(
      userId,
      "You're in! 🎉",
      `Your request for ${eventTitle} was approved. Check your tickets.`,
      { type: 'approved' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Declined
app.post('/notify/declined', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(
      userId,
      'Request declined',
      `Your request for ${eventTitle} was not approved.`,
      { type: 'declined' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// New request (notifies host)
app.post('/notify/new-request', async (req, res) => {
  const { hostId, guestName, eventTitle } = req.body;
  try {
    const result = await sendNotification(
      hostId,
      'New attendance request',
      `${guestName} wants to attend ${eventTitle}.`,
      { type: 'new-request' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Location reveal
app.post('/notify/location-reveal', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(
      userId,
      'Location dropped 📍',
      `${eventTitle} — open your ticket for the address.`,
      { type: 'location-reveal' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Event cancelled
app.post('/notify/event-cancelled', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(
      userId,
      'Event cancelled',
      `${eventTitle} has been cancelled.`,
      { type: 'event-cancelled' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Waitlist promoted
app.post('/notify/waitlist-promoted', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(
      userId,
      "You're in! 🎉",
      `A spot opened up for ${eventTitle} — you've been approved!`,
      { type: 'waitlist-promoted' }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
