const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ─── Firebase Admin ───────────────────────────────────────────────────────────
// Set FIREBASE_SERVICE_ACCOUNT_JSON in Railway dashboard.
// Get it from: Firebase Console → Project Settings → Service Accounts → Generate key.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ─── OneSignal ────────────────────────────────────────────────────────────────
const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
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

// ─── Auth middleware ──────────────────────────────────────────────────────────
// Verifies the Firebase ID token sent by the Flutter app as Bearer <token>.
async function verifyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    req.uid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RSVP ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// POST /rsvp/approve
// Called by host to approve or decline a pending request.
// Atomically: checks capacity, creates ticket, decrements spotsRemaining.
app.post('/rsvp/approve', verifyAuth, async (req, res) => {
  const { requestId, approve } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  try {
    const reqRef = db.collection('rsvp_requests').doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) return res.status(404).json({ error: 'Request not found' });
    const reqData = reqSnap.data();

    if (reqData.hostUid !== req.uid) {
      return res.status(403).json({ error: 'Only the host can approve or decline' });
    }

    if (!approve) {
      await reqRef.update({ status: 'declined', updatedAt: FieldValue.serverTimestamp() });
      sendNotification(reqData.userId, 'Request declined',
        'Your attendance request was not approved.', { type: 'declined' }).catch(() => {});
      return res.json({ result: 'declined' });
    }

    const eventRef = db.collection('events').doc(reqData.eventId);
    let wasWaitlisted = false;

    await db.runTransaction(async (tx) => {
      const eventSnap = await tx.get(eventRef);
      if (!eventSnap.exists) throw new Error('Event not found');
      const eventData = eventSnap.data();

      const rawSpots = eventData.spotsRemaining;
      const unlimited = rawSpots === undefined || rawSpots === null;
      const spots = unlimited ? Number.MAX_SAFE_INTEGER : rawSpots;

      if (spots <= 0) {
        wasWaitlisted = true;
        tx.update(reqRef, { status: 'waitlisted', updatedAt: FieldValue.serverTimestamp() });
        return;
      }

      const ticketRef = db.collection('tickets').doc();
      tx.set(ticketRef, {
        userId:          reqData.userId,
        userDisplayName: reqData.userDisplayName ?? 'Guest',
        eventId:         reqData.eventId,
        hostUid:         reqData.hostUid,
        token:           uuidv4(),
        status:          'valid',
        issuedAt:        FieldValue.serverTimestamp(),
        usedAt:          null,
        cancelledAt:     null,
        eventTitle:      eventData.title ?? null,
        eventDate:       eventData.date ?? null,
        eventVenue:      eventData.venue ?? null,
        eventAddress:    eventData.address ?? null,
        eventImageUrl:   eventData.image ?? eventData.imageUrl ?? null,
        locationRevealAt: eventData.locationRevealAt ?? null,
      });
      tx.update(reqRef, { status: 'approved', updatedAt: FieldValue.serverTimestamp() });
      if (!unlimited) {
        tx.update(eventRef, { spotsRemaining: FieldValue.increment(-1) });
      }
    });

    if (wasWaitlisted) {
      sendNotification(reqData.userId, "You're on the waitlist",
        "The event is full — you'll be notified if a spot opens.", { type: 'waitlisted' }).catch(() => {});
      return res.json({ result: 'waitlisted' });
    }

    sendNotification(reqData.userId, "You're in! 🎉",
      'Your request was approved. Check your tickets.', { type: 'approved' }).catch(() => {});
    return res.json({ result: 'approved' });
  } catch (e) {
    console.error('/rsvp/approve error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TICKET ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// POST /tickets/validate
// Called by host's QR scanner. Validates a token and marks the ticket as used.
app.post('/tickets/validate', verifyAuth, async (req, res) => {
  const { token, eventId } = req.body;
  if (!token || !eventId) return res.status(400).json({ error: 'token and eventId required' });

  try {
    const snap = await db.collection('tickets')
      .where('token', '==', token)
      .where('eventId', '==', eventId)
      .limit(1)
      .get();

    if (snap.empty) return res.json({ valid: false, reason: 'Ticket not found' });

    const doc = snap.docs[0];
    const data = doc.data();

    if (data.hostUid !== req.uid) return res.status(403).json({ error: 'Not your event' });
    if (data.status === 'cancelled') return res.json({ valid: false, reason: 'Ticket cancelled' });
    if (data.status === 'used') {
      return res.json({ valid: false, reason: 'Already scanned', guestName: data.userDisplayName ?? 'Guest' });
    }

    await doc.ref.update({ status: 'used', usedAt: FieldValue.serverTimestamp() });
    return res.json({ valid: true, guestName: data.userDisplayName ?? 'Guest' });
  } catch (e) {
    console.error('/tickets/validate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /tickets/cancel
// Called by guest to cancel their ticket.
// Atomically cancels the ticket and auto-promotes the next person on the waitlist.
app.post('/tickets/cancel', verifyAuth, async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });

  try {
    const ticketRef = db.collection('tickets').doc(ticketId);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists) return res.status(404).json({ error: 'Ticket not found' });
    const ticketData = ticketSnap.data();

    if (ticketData.userId !== req.uid) return res.status(403).json({ error: 'Not your ticket' });
    if (ticketData.status !== 'valid') return res.status(400).json({ error: 'Ticket is not valid' });

    const eventId = ticketData.eventId;

    // Cancel the ticket
    await ticketRef.update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() });

    // Check if the event is already cancelled — if so, skip waitlist promotion
    const eventSnap = await db.collection('events').doc(eventId).get();
    if (!eventSnap.exists || eventSnap.data().status === 'cancelled') {
      return res.json({ result: 'cancelled' });
    }
    const eventData = eventSnap.data();

    // Look for oldest waitlisted request
    const waitSnap = await db.collection('rsvp_requests')
      .where('eventId', '==', eventId)
      .where('status', '==', 'waitlisted')
      .orderBy('requestedAt')
      .limit(1)
      .get();

    if (waitSnap.empty) {
      // No waitlist — return the spot if event has finite capacity
      if (eventData.spotsRemaining !== undefined && eventData.spotsRemaining !== null) {
        await db.collection('events').doc(eventId).update({
          spotsRemaining: FieldValue.increment(1),
        });
      }
      return res.json({ result: 'cancelled' });
    }

    // Promote next person from waitlist
    const nextReq = waitSnap.docs[0];
    const nextData = nextReq.data();

    await db.runTransaction(async (tx) => {
      const newTicketRef = db.collection('tickets').doc();
      tx.set(newTicketRef, {
        userId:          nextData.userId,
        userDisplayName: nextData.userDisplayName ?? 'Guest',
        eventId,
        hostUid:         nextData.hostUid,
        token:           uuidv4(),
        status:          'valid',
        issuedAt:        FieldValue.serverTimestamp(),
        usedAt:          null,
        cancelledAt:     null,
        eventTitle:      eventData.title ?? null,
        eventDate:       eventData.date ?? null,
        eventVenue:      eventData.venue ?? null,
        eventAddress:    eventData.address ?? null,
        eventImageUrl:   eventData.image ?? eventData.imageUrl ?? null,
        locationRevealAt: eventData.locationRevealAt ?? null,
      });
      tx.update(nextReq.ref, { status: 'approved', updatedAt: FieldValue.serverTimestamp() });
      // Spot count stays the same: one cancelled → one promoted = net zero
    });

    sendNotification(nextData.userId, "You're in! 🎉",
      `A spot opened up — you've been approved!`, { type: 'waitlist-promoted' }).catch(() => {});

    return res.json({ result: 'cancelled', promoted: nextData.userId });
  } catch (e) {
    console.error('/tickets/cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EVENT ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// POST /events/cancel
// Called by host to cancel an event. Bulk-cancels all valid tickets and notifies guests.
app.post('/events/cancel', verifyAuth, async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    const eventRef = db.collection('events').doc(eventId);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) return res.status(404).json({ error: 'Event not found' });
    if (eventSnap.data().hostUid !== req.uid) return res.status(403).json({ error: 'Not your event' });

    const ticketsSnap = await db.collection('tickets')
      .where('eventId', '==', eventId)
      .where('status', '==', 'valid')
      .get();

    const batch = db.batch();
    const userIds = [];
    for (const doc of ticketsSnap.docs) {
      batch.update(doc.ref, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() });
      userIds.push(doc.data().userId);
    }
    batch.update(eventRef, { status: 'cancelled' });
    await batch.commit();

    const title = eventSnap.data().title ?? 'An event';
    for (const uid of userIds) {
      sendNotification(uid, 'Event cancelled', `${title} has been cancelled.`,
        { type: 'event-cancelled' }).catch(() => {});
    }

    return res.json({ result: 'cancelled', ticketsCancelled: ticketsSnap.size });
  } catch (e) {
    console.error('/events/cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Scheduled location reveal ─────────────────────────────────────────────
// POST /admin/location-reveal-check
// Call this every 5 minutes via an external cron service (e.g. cron-job.org).
// Protect with ADMIN_SECRET env var so only the cron caller can trigger it.
app.post('/admin/location-reveal-check', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const now = admin.firestore.Timestamp.now();
    const fiveMinsAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 5 * 60 * 1000);

    const snap = await db.collection('events')
      .where('locationRevealAt', '>=', fiveMinsAgo)
      .where('locationRevealAt', '<=', now)
      .where('locationRevealed', '==', false)
      .get();

    let notified = 0;
    for (const eventDoc of snap.docs) {
      const eventData = eventDoc.data();
      const ticketsSnap = await db.collection('tickets')
        .where('eventId', '==', eventDoc.id)
        .where('status', '==', 'valid')
        .get();

      for (const ticketDoc of ticketsSnap.docs) {
        sendNotification(ticketDoc.data().userId, 'Location dropped 📍',
          `${eventData.title ?? "Tonight's event"} — open your ticket for the address.`,
          { type: 'location-reveal' }).catch(() => {});
        notified++;
      }
      await eventDoc.ref.update({ locationRevealed: true });
    }
    res.json({ eventsProcessed: snap.size, notified });
  } catch (e) {
    console.error('/admin/location-reveal-check error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ONESIGNAL NOTIFICATION ENDPOINTS (existing — unchanged)
// ═════════════════════════════════════════════════════════════════════════════

app.post('/notify/approved', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(userId, "You're in! 🎉",
      `Your request for ${eventTitle} was approved. Check your tickets.`, { type: 'approved' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify/declined', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(userId, 'Request declined',
      `Your request for ${eventTitle} was not approved.`, { type: 'declined' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify/new-request', async (req, res) => {
  const { hostId, guestName, eventTitle } = req.body;
  try {
    const result = await sendNotification(hostId, 'New attendance request',
      `${guestName} wants to attend ${eventTitle}.`, { type: 'new-request' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify/location-reveal', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(userId, 'Location dropped 📍',
      `${eventTitle} — open your ticket for the address.`, { type: 'location-reveal' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify/event-cancelled', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(userId, 'Event cancelled',
      `${eventTitle} has been cancelled.`, { type: 'event-cancelled' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify/waitlist-promoted', async (req, res) => {
  const { userId, eventTitle } = req.body;
  try {
    const result = await sendNotification(userId, "You're in! 🎉",
      `A spot opened up for ${eventTitle} — you've been approved!`, { type: 'waitlist-promoted' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
