const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const msgRetryCounterCache = new NodeCache();

let sock = null;
let pairingCodeRequested = false;
let currentPairingNumber = '';
let contactsData = [];
let groupsData = [];

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Logger
const logger = pino({ level: 'silent' });

// Connect to WhatsApp
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false,
    browser: ['WhatsApp UID Tool', 'Chrome', '10.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[CONNECTION] Status: ${connection}`);

    io.emit('connection-status', { connection, lastDisconnect });

    if (connection === 'open') {
      pairingCodeRequested = false;
      io.emit('connected', { user: sock.user });
      await loadContactsAndGroups();
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(connectWhatsApp, 3000);
      } else {
        fs.rmSync('./auth_session', { recursive: true, force: true });
        io.emit('logged-out');
      }
    }
  });

  return sock;
}

// Request Pairing Code
async function requestPairing(phoneNumber) {
  if (!sock) await connectWhatsApp();
  
  // Wait for socket to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
  currentPairingNumber = cleanNumber;
  
  try {
    const code = await sock.requestPairingCode(cleanNumber);
    const formattedCode = code.match(/.{1,4}/g).join('-');
    io.emit('pairing-code', { code: formattedCode });
    return formattedCode;
  } catch (err) {
    console.error('Pairing error:', err);
    throw err;
  }
}

// Load contacts and groups
async function loadContactsAndGroups() {
  try {
    // Load contacts
    const contacts = await sock.getContacts();
    contactsData = Object.values(contacts).map(c => ({
      id: c.id,
      name: c.name || c.notify || c.verifiedName || 'Unknown',
      number: c.id.split('@')[0]
    })).filter(c => c.id.includes('@s.whatsapp.net'));

    // Load groups
    const groups = await sock.groupFetchAllParticipating();
    groupsData = Object.values(groups).map(g => ({
      id: g.id,
      subject: g.subject || 'Unknown Group',
      participants: g.participants?.length || 0,
      creation: g.creation,
      owner: g.owner
    }));

    io.emit('data-loaded', {
      contacts: contactsData,
      groups: groupsData,
      user: sock.user
    });

    console.log(`✅ Loaded ${contactsData.length} contacts, ${groupsData.length} groups`);
  } catch (err) {
    console.error('Load error:', err);
  }
}

// API Routes
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    const code = await requestPairing(phone);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: sock?.user ? true : false,
    user: sock?.user || null,
    contacts: contactsData.length,
    groups: groupsData.length
  });
});

app.get('/api/contacts', (req, res) => {
  res.json(contactsData);
});

app.get('/api/groups', (req, res) => {
  res.json(groupsData);
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    fs.rmSync('./auth_session', { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('[SOCKET] Client connected');
  socket.emit('connection-status', {
    connection: sock?.user ? 'open' : 'close'
  });
  if (sock?.user) {
    socket.emit('data-loaded', {
      contacts: contactsData,
      groups: groupsData,
      user: sock.user
    });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 Server running at: http://localhost:${PORT}`);
  console.log(`📱 Open browser and enter phone number to pair\n`);
  connectWhatsApp();
});
