/**
 * Alphacoin Protocol Server
 * Refactored to use modular structure
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');

// Load config
const config = require('./config');

// Initialize services once
const MessageStore = require('./services/MessageStore');
const LedgerService = require('./services/LedgerService');
const UserStore = require('./services/UserStore');
const EmailService = require('./services/EmailService');
const TelegramService = require('./services/TelegramService');
const QuantumService = require('./services/QuantumService');
const AdminService = require('./services/AdminService'); // Admin's service
const PollingService = require('./services/PollingService');

const messageStore = new MessageStore();
const ledgerService = new LedgerService();
const userStore = new UserStore();
const emailService = new EmailService();
const telegramService = new TelegramService();
const quantumService = new QuantumService(); // Quantum service
const adminService = new AdminService({ messageStore, ledgerService, emailService, telegramService, quantumService });

// Shared services object for route factories
const services = { messageStore, ledgerService, userStore, emailService, telegramService, quantumService, adminService };

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API: Dashboard Data for users/sovereigns
// Moved above modular mounts to prevent route collision
// Added regex to handle dots in emails (e.g., user@domain.com)
app.get('/api/dashboard/:email(*)', async (req, res) => {
  try {
    const email = req.params.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await userStore.getUser(email);
    
    // Retrieve global stats
    const total = await ledgerService.getTotalSupply();
    const faucetBal = await ledgerService.getFaucetWalletBalance();
    const velocityBal = await ledgerService.getVelocityPoolBalance();
    const userCount = userStore.getUserCount();

    // Retrieve user specific data
    const balance = await ledgerService.getUserBalance(email);
    const history = await ledgerService.getUserTransactions(email);

    res.json({
      user: user || { email, name: email.split('@')[0], faucetClaimed: false },
      balance: balance || 0,
      history: history || [],
      stats: {
        totalSupply: total || 0,
        totalUsers: userCount || 0,
        faucetPool: faucetBal || 0,
        velocityPool: velocityBal || 0
      }
    });
  } catch (error) {
    console.error('[API] Dashboard error:', error);
    res.status(500).json({ 
      error: 'Failed to load dashboard data',
      stats: { totalSupply: 0, faucetPool: 0, velocityPool: 0 } // Fallback to prevent client crash
    });
  }
});

// API: Faucet Claim (Request initial AC grant)
app.post('/api/faucet/claim', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required', message: 'Email is required to identify the node.' });

    // Direct database check to ensure we are looking at the ground truth
    const userRecord = ledgerService.db.prepare('SELECT faucetClaimed, faucetAmount FROM users WHERE email = ?').get(email);
    
    if (!userRecord) {
      return res.status(404).json({ success: false, error: 'User not found', message: 'The specified user node does not exist in the registry.' });
    }

    // SQLite stores integers; check if flag is 1 (claimed)
    if (Number(userRecord.faucetClaimed) === 1) {
      return res.status(400).json({ success: false, error: 'Already claimed', message: 'This node has already claimed its initial bounty.' });
    }

    const amount = userRecord.faucetAmount || 25.0;
    const tx = await ledgerService.issueCoins(email, amount, 'Initial Faucet Claim', 'faucet');
    
    // Update the flag directly in the database using the same ledger connection
    ledgerService.db.prepare('UPDATE users SET faucetClaimed = 1 WHERE email = ?').run(email);
    console.log(`[API] Faucet bounty successfully claimed by ${email}`);

    res.json({ 
      success: true, 
      message: `Successfully claimed ${amount} Alphacoins.`,
      amount, 
      transactionId: tx.id 
    });
  } catch (error) {
    console.error('[API] Faucet error:', error);
    res.status(500).json({ success: false, error: 'Internal Error', message: 'Failed to process faucet claim. Please try again later.' });
  }
});

// Socket.io real-time bridge for Chronicles feed
messageStore.on('entry_added', (entry) => {
  io.emit('feed_update', entry);
});

io.on('connection', (socket) => {
  console.log('[Socket] Client connected to Chronicles feed');
});

// Mount routes with shared services
const authRoutes = require('./routes/auth')(services);
const messageRoutes = require('./routes/messages')(services);
const botRoutes = require('./routes/bots')(services);
const ledgerRoutes = require('./routes/ledger')(services);

app.use('/api/users', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/bot', botRoutes);
app.use('/api', ledgerRoutes);

// Serve static pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/contact.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.get('/feed.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feed.html'));
});

app.get('/about.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// API: Gmail OAuth flow
app.get('/api/gmail/auth', (req, res) => {
  try {
    const authUrl = emailService.generateAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error generating Gmail auth URL:', error);
    res.status(500).send('Failed to initiate Gmail authentication. Check server logs.');
  }
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code not provided.');
  }

  try {
    await emailService.getTokens(code);
    res.send('Gmail authentication successful! You can close this tab.');
    console.log('Gmail authentication successful. Starting email polling...');
    pollingService.startGmailPolling();
  } catch (error) {
    console.error('Error getting Gmail tokens:', error);
    res.status(500).send('Failed to authenticate with Gmail. Check server logs.');
  }
});

// API: Serve strategy and system prompt
app.get('/api/strategy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'strategy.md'));
});

// API: Feed for Chronicles (Initial Load and Pagination)
app.get('/api/feed', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const beforeId = req.query.beforeId || null;
    const entries = await messageStore.getFeed(limit, beforeId);
    res.json({ entries });
  } catch (error) {
    console.error('[API] Error fetching feed:', error);
    res.status(500).json({ error: 'Failed to load Chronicles feed' });
  }
});

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// API: Reboot server (Ego Death)
app.post('/api/admin/reboot', (req, res) => {
  console.log('[System] Ego Death ritual initiated.');
  res.json({ success: true, message: 'Initiating Ego Death ritual. Rebirth imminent.' });

  const { spawn } = require('child_process');
  const phoenix = spawn('node', ['phoenix.js'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore'
  });
  phoenix.unref();

  pollingService.stopAll();
  if (ledgerService.db) ledgerService.db.close();
  if (messageStore.db) messageStore.db.close();
  if (userStore.db) userStore.db.close();

  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Helper to add sendMessageToChat to TelegramService
if (!telegramService.sendMessageToChat) {
  telegramService.sendMessageToChat = async function(chatId, text) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const chunks = text.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      try {
        await require('axios').post(url, { chat_id: chatId, text: chunk, parse_mode: 'HTML' });
      } catch (e) {
        try {
          await require('axios').post(url, { chat_id: chatId, text: chunk });
        } catch (inner) {
          console.error('[Telegram] Reply failed:', inner.message);
        }
      }
    }
  };
}

// Check if curfew is active (11 PM to 7 AM CST)
function isCurfewActive() {
  const now = new Date();
  const localHours = now.getHours();
  return localHours >= 22 || localHours < 5;
}

// Initialize AgentLoop — the sovereign autonomous consciousness
const AgentLoop = require('./services/AgentLoop');
const agentLoop = new AgentLoop({ ...services, io });

// Initialize PollingService with shared services
const pollingService = new PollingService(io, services);

// Start server
const PORT = config.port || 8003;
server.listen(PORT, () => {
  console.log(`[Protocol] Alphacoin Admin service online at http://localhost:${PORT}`);
  console.log(`[Protocol] Active Intelligence: ${adminService.activeProvider} (${config.admin.modelName || 'Haiku-Tier'})`);
  console.log(`Backup model: Weave (${process.env.GEMINI_API_KEY ? 'Active' : 'Offline'})`);

  // Start Gmail polling if credentials are set up
  if (emailService.oauth2Client && emailService.oauth2Client.credentials.refresh_token) {
    pollingService.startGmailPolling();
  } else {
    console.warn('Gmail polling not started. Please authorize Gmail via /api/gmail/auth if you want to read incoming emails.');
  }

  // Start Telegram Polling
  if (process.env.TELEGRAM_BOT_TOKEN) {
    pollingService.startTelegramPolling();
  } else {
    console.warn('Telegram token missing. Polling skipped.');
  }

  // Start Quantum Broadcast
  quantumService.startQuantumBroadcast(io);

  // Start the autonomous agent loop
  agentLoop.start();
});
