// routes/payment.js - Payment processing and transaction routes
const express = require('express');
const { authenticateToken, requireKYC } = require('../middleware/auth');
const PaymentService = require('../services/paymentService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiting for payment operations
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 payment operations per 15 minutes
  message: {
    success: false,
    message: 'Too many payment requests, please try again later.'
  }
});

// @route   POST /api/payment/withdraw
// @desc    Request withdrawal
// @access  Private (KYC required)
router.post('/withdraw', authenticateToken, requireKYC('verified'), paymentLimiter, async (req, res) => {
  try {
    const { amount, method, accountInfo } = req.body;

    // Validation
    if (!amount || !method || !accountInfo) {
      return res.status(400).json({
        success: false,
        message: 'Amount, withdrawal method, and account information are required'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    const minWithdrawal = parseFloat(process.env.MIN_WITHDRAWAL) || 10;
    if (amount < minWithdrawal) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is ${minWithdrawal} BigCoin`
      });
    }

    const validMethods = ['bank_transfer', 'crypto', 'paypal'];
    if (!validMethods.includes(method)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid withdrawal method'
      });
    }

    // Check user balance
    const currentBalance = await Transaction.getUserBalance(req.user._id);
    if (currentBalance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
        currentBalance,
        requestedAmount: amount
      });
    }

    // KYC verification for large amounts
    const kycCheck = await PaymentService.verifyKYCForTransaction(req.user._id, amount, 'withdrawal');
    if (!kycCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: 'KYC verification required for this amount',
        requiredLevel: kycCheck.requiredLevel,
        currentLevel: kycCheck.currentLevel
      });
    }

    // Risk assessment
    const riskAssessment = await PaymentService.monitorSuspiciousActivity(req.user._id, {
      type: 'withdrawal',
      amount,
      location: req.headers['x-user-location'] || req.ip
    });

    if (riskAssessment.requiresReview) {
      return res.status(202).json({
        success: false,
        message: 'Withdrawal requires manual review',
        riskFlags: riskAssessment.flags,
        estimatedReviewTime: '24-48 hours'
      });
    }

    const result = await PaymentService.processWithdrawal(req.user._id, amount, method, accountInfo);

    res.json(result);

  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/payment/deposit
// @desc    Process deposit
// @access  Private
router.post('/deposit', authenticateToken, paymentLimiter, async (req, res) => {
  try {
    const { amount, paymentMethodId, currency = 'USD' } = req.body;

    if (!amount || !paymentMethodId) {
      return res.status(400).json({
        success: false,
        message: 'Amount and payment method are required'
      });
    }

    if (amount <= 0 || amount > 10000) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be between $1 and $10,000'
      });
    }

    const validCurrencies = ['USD', 'VND', 'SGD'];
    if (!validCurrencies.includes(currency)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid currency'
      });
    }

    const result = await PaymentService.processDeposit(req.user._id, amount, paymentMethodId, currency);

    res.json(result);

  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/payment/balance
// @desc    Get user balance
// @access  Private
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const calculatedBalance = await Transaction.getUserBalance(req.user._id);

    // Sync calculated balance with user record if different
    if (Math.abs(calculatedBalance - user.coins.available) > 0.001) {
      user.coins.available = calculatedBalance;
      await user.save();
    }

    const pendingWithdrawals = await Transaction.find({
      userId: req.user._id,
      type: 'withdrawal',
      status: { $in: ['pending', 'processing'] }
    });

    const pendingAmount = pendingWithdrawals.reduce((sum, tx) => sum + tx.amount, 0);

    res.json({
      success: true,
      balance: {
        available: user.coins.available,
        pending: pendingAmount,
        total: user.coins.total
      },
      pendingTransactions: pendingWithdrawals.length
    });

  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving balance'
    });
  }
});

// @route   GET /api/payment/history
// @desc    Get transaction history
// @access  Private
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      type, 
      status, 
      startDate, 
      endDate 
    } = req.query;

    const filters = {};
    if (type) filters.type = type;
    if (status) filters.status = status;
    if (startDate || endDate) {
      filters.createdAt = {};
      if (startDate) filters.createdAt.$gte = new Date(startDate);
      if (endDate) filters.createdAt.$lte = new Date(endDate);
    }

    const history = await PaymentService.getTransactionHistory(req.user._id, filters);

    // Paginate results
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedHistory = history.slice(startIndex, endIndex);

    res.json({
      success: true,
      transactions: paginatedHistory,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: history.length,
        pages: Math.ceil(history.length / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get transaction history error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving transaction history'
    });
  }
});

// @route   GET /api/payment/exchange-rates
// @desc    Get current exchange rates
// @access  Public
router.get('/exchange-rates', async (req, res) => {
  try {
    const rates = await PaymentService.getExchangeRates();

    res.json({
      success: true,
      rates,
      updatedAt: new Date()
    });

  } catch (error) {
    console.error('Get exchange rates error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving exchange rates'
    });
  }
});

// @route   POST /api/payment/convert
// @desc    Convert currency amounts
// @access  Public
router.post('/convert', async (req, res) => {
  try {
    const { amount, fromCurrency, toCurrency } = req.body;

    if (!amount || !fromCurrency || !toCurrency) {
      return res.status(400).json({
        success: false,
        message: 'Amount, from currency, and to currency are required'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    const conversion = await PaymentService.convertCurrency(amount, fromCurrency, toCurrency);

    res.json({
      success: true,
      conversion
    });

  } catch (error) {
    console.error('Currency conversion error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/payment/premium/subscribe
// @desc    Subscribe to premium plan
// @access  Private
router.post('/premium/subscribe', authenticateToken, paymentLimiter, async (req, res) => {
  try {
    const { plan, paymentMethodId } = req.body;

    if (!plan || !paymentMethodId) {
      return res.status(400).json({
        success: false,
        message: 'Plan and payment method are required'
      });
    }

    const validPlans = ['basic', 'premium', 'vip'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid subscription plan'
      });
    }

    // Check if user already has active subscription
    const user = await User.findById(req.user._id);
    if (user.subscriptions.premium.active && user.subscriptions.premium.expiresAt > new Date()) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active subscription'
      });
    }

    const result = await PaymentService.processPremiumSubscription(req.user._id, plan, paymentMethodId);

    res.json(result);

  } catch (error) {
    console.error('Premium subscription error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/payment/premium/cancel
// @desc    Cancel premium subscription
// @access  Private
router.post('/premium/cancel', authenticateToken, async (req, res) => {
  try {
    const result = await PaymentService.cancelSubscription(req.user._id);

    res.json(result);

  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/payment/fees/calculate
// @desc    Calculate fees for transaction
// @access  Private
router.get('/fees/calculate', authenticateToken, async (req, res) => {
  try {
    const { amount, type, method } = req.query;

    if (!amount || !type) {
      return res.status(400).json({
        success: false,
        message: 'Amount and transaction type are required'
      });
    }

    const numAmount = parseFloat(amount);
    if (numAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    const fees = PaymentService.calculateFees(numAmount, type, method);

    res.json({
      success: true,
      amount: numAmount,
      fees,
      netAmount: numAmount - fees.total,
      type,
      method
    });

  } catch (error) {
    console.error('Calculate fees error:', error);
    res.status(500).json({
      success: false,
      message: 'Error calculating fees'
    });
  }
});

// @route   GET /api/payment/withdrawal-methods
// @desc    Get available withdrawal methods
// @access  Private
router.get('/withdrawal-methods', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    const methods = [
      {
        id: 'bank_transfer',
        name: 'Bank Transfer',
        description: 'Transfer to your bank account',
        fee: '2% + $5',
        processingTime: '1-3 business days',
        minAmount: 50,
        maxAmount: 10000,
        available: user.kyc.status === 'verified',
        requirements: user.kyc.status !== 'verified' ? ['KYC verification required'] : []
      },
      {
        id: 'crypto',
        name: 'Cryptocurrency',
        description: 'Transfer to crypto wallet (USDT)',
        fee: '1%',
        processingTime: '10-30 minutes',
        minAmount: 10,
        maxAmount: 50000,
        available: true,
        requirements: []
      },
      {
        id: 'paypal',
        name: 'PayPal',
        description: 'Transfer to PayPal account',
        fee: '2.5%',
        processingTime: '2-5 business days',
        minAmount: 25,
        maxAmount: 5000,
        available: user.kyc.status === 'verified',
        requirements: user.kyc.status !== 'verified' ? ['KYC verification required'] : []
      }
    ];

    res.json({
      success: true,
      methods,
      userKycStatus: user.kyc.status
    });

  } catch (error) {
    console.error('Get withdrawal methods error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving withdrawal methods'
    });
  }
});

// @route   POST /api/payment/webhook/stripe
// @desc    Handle Stripe webhooks
// @access  Public (webhook)
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const result = await PaymentService.handleStripeWebhook(event);

    if (result.success) {
      res.json({ received: true });
    } else {
      res.status(500).json({ error: result.error });
    }

  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// @route   GET /api/payment/transaction/:id
// @desc    Get transaction details
// @access  Private
router.get('/transaction/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const transaction = await Transaction.findOne({
      $or: [
        { _id: id },
        { transactionId: id }
      ],
      userId: req.user._id
    }).populate('metadata.gameId', 'musicId scoring');

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      transaction
    });

  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving transaction'
    });
  }
});

// @route   GET /api/payment/stats
// @desc    Get user payment statistics
// @access  Private
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    const startDate = new Date();
    switch (period) {
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(startDate.getDate() - 90);
        break;
      case 'all':
        startDate.setFullYear(2000);
        break;
    }

    const stats = await Transaction.aggregate([
      {
        $match: {
          userId: req.user._id,
          createdAt: { $gte: startDate },
          status: 'completed'
        }
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          avgAmount: { $avg: '$amount' }
        }
      }
    ]);

    // Calculate summary statistics
    let totalEarned = 0;
    let totalWithdrawn = 0;
    let totalDeposited = 0;
    let transactionCount = 0;

    stats.forEach(stat => {
      transactionCount += stat.count;
      switch (stat._id) {
        case 'game_reward':
        case 'bonus':
        case 'referral':
          totalEarned += stat.totalAmount;
          break;
        case 'withdrawal':
          totalWithdrawn += stat.totalAmount;
          break;
        case 'deposit':
          totalDeposited += stat.totalAmount;
          break;
      }
    });

    res.json({
      success: true,
      period,
      stats: {
        totalEarned,
        totalWithdrawn,
        totalDeposited,
        netEarnings: totalEarned - totalWithdrawn,
        transactionCount,
        byType: stats
      }
    });

  } catch (error) {
    console.error('Get payment stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving payment statistics'
    });
  }
});

// @route   POST /api/payment/validate-wallet
// @desc    Validate cryptocurrency wallet address
// @access  Public
router.post('/validate-wallet', async (req, res) => {
  try {
    const { address, currency = 'USDT' } = req.body;

    if (!address) {
      return res.status(400).json({
        success: false,
        message: 'Wallet address is required'
      });
    }

    const isValid = PaymentService.validateWalletAddress(address);

    res.json({
      success: true,
      valid: isValid,
      address,
      currency,
      message: isValid ? 'Valid wallet address' : 'Invalid wallet address format'
    });

  } catch (error) {
    console.error('Validate wallet error:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating wallet address'
    });
  }
});

module.exports = router;