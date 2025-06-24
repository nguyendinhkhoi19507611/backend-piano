
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');
const { securityHeaders } = require('./middleware/auth');
const GameService = require('./services/gameService');
const cron = require('node-cron');

// Load environment variables
require('dotenv').config();

// Initialize Express app
const app = express();

// Connect to MongoDB
connectDB();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      mediaSrc: ["'self'", "https:"],
      connectSrc: ["'self'", "wss:", "https:"]
    }
  }
}));

app.use(securityHeaders);

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://bigcoin-piano.com',
      'https://www.bigcoin-piano.com'
    ];
    
    if (process.env.NODE_ENV === 'development') {
      allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000');
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID', 'X-User-Location']
};

app.use(cors(corsOptions));

// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 1000 : 10000, // Requests per window
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for webhooks
    return req.path.includes('/webhook');
  }
});

app.use(globalLimiter);

// Body parsing middleware
app.use('/api/payment/webhook', express.raw({ type: 'application/json' })); // Raw for webhooks
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy (for deployment behind load balancer)
app.set('trust proxy', 1);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'BigCoin Piano API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '1.0.0'
  });
});
app.get('/proxy-audio', async (req, res) => {
  const url = req.query.url;
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  
  res.set('Content-Type', 'audio/mpeg');
  res.send(Buffer.from(buffer));
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/game', require('./routes/game'));
app.use('/api/music', require('./routes/music'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/spotify', require('./routes/spotify'));

// Socket.IO setup for real-time game features
const http = require('http');
const socketIo = require('socket.io');

const server = http.createServer(app);
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Socket.IO middleware for authentication
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const User = require('./models/User');
    const user = await User.findById(decoded.userId);
    
    if (!user || user.status !== 'active') {
      return next(new Error('Invalid user'));
    }

    socket.userId = user._id.toString();
    socket.user = user;
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User ${socket.user.username} connected`);

  // Join user-specific room
  socket.join(`user_${socket.userId}`);

  // Handle game session events
  socket.on('join_game', async (data) => {
    try {
      const { sessionId } = data;
      const isValid = await GameService.validateSession(sessionId, socket.userId);
      
      if (isValid) {
        socket.join(`game_${sessionId}`);
        socket.emit('game_joined', { sessionId, success: true });
      } else {
        socket.emit('game_error', { message: 'Invalid game session' });
      }
    } catch (error) {
      socket.emit('game_error', { message: error.message });
    }
  });

  // Handle real-time keystroke events
  socket.on('keystroke', async (data) => {
    try {
      const { sessionId, key, timestamp, accuracy, reactionTime } = data;
      
      const result = await GameService.processKeystroke(sessionId, {
        key,
        timestamp,
        accuracy,
        reactionTime
      });

      // Emit to game room for multiplayer features (future)
      socket.to(`game_${sessionId}`).emit('player_keystroke', {
        userId: socket.userId,
        username: socket.user.username,
        ...result
      });

      socket.emit('keystroke_result', result);
    } catch (error) {
      socket.emit('game_error', { message: error.message });
    }
  });

  // Handle game state updates
  socket.on('game_state_update', (data) => {
    const { sessionId, state } = data;
    socket.to(`game_${sessionId}`).emit('player_state_update', {
      userId: socket.userId,
      username: socket.user.username,
      state
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User ${socket.user.username} disconnected`);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);

  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      message: 'CORS policy violation'
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      details: err.errors
    });
  }

  // MongoDB duplicate key error
  if (err.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'Duplicate entry',
      field: Object.keys(err.keyPattern)[0]
    });
  }

  // Default error response
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' 
      ? 'Something went wrong!' 
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Scheduled tasks
if (process.env.NODE_ENV === 'production') {
  // Clean up expired game sessions every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    try {
      console.log('Running cleanup job...');
      const cleanedUp = await GameService.cleanupExpiredSessions();
      console.log(`Cleaned up ${cleanedUp} expired sessions`);
    } catch (error) {
      console.error('Cleanup job error:', error);
    }
  });

  // Update crypto prices every hour
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('Updating crypto prices...');
      const PaymentService = require('./services/paymentService');
      await PaymentService.updateCryptoPrices();
      console.log('Crypto prices updated');
    } catch (error) {
      console.error('Price update error:', error);
    }
  });

  // Generate daily reports at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      console.log('Generating daily reports...');
      const PaymentService = require('./services/paymentService');
      const report = await PaymentService.generateFinancialReport('24h');
      console.log('Daily report generated:', report.summary);
    } catch (error) {
      console.error('Daily report error:', error);
    }
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
🎹 BigCoin Piano Mining Game Backend
🚀 Server running on port ${PORT}
🌍 Environment: ${process.env.NODE_ENV}
📊 Database: ${process.env.MONGODB_URI ? 'Connected' : 'Configuration needed'}
💰 Payment: ${process.env.STRIPE_SECRET_KEY ? 'Stripe configured' : 'Payment setup needed'}
  `);
});

module.exports = { app, server, io };