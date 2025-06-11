
const mongoose = require('mongoose');
const crypto = require('crypto');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  transactionId: {
    type: String,
    unique: true,
    required: true
  },
  type: {
    type: String,
    enum: [
      'game_reward',    // Nhận thưởng từ game
      'withdrawal',     // Rút tiền
      'deposit',        // Nạp tiền  
      'bonus',          // Thưởng từ hệ thống
      'referral',       // Thưởng giới thiệu
      'penalty',        // Phạt
      'refund',         // Hoàn tiền
      'fee',            // Phí dịch vụ
      'purchase'        // Mua premium/items
    ],
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    enum: ['BIGCOIN', 'USD', 'VND', 'SGD'],
    default: 'BIGCOIN'
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'expired'],
    default: 'pending',
    index: true
  },
  description: {
    type: String,
    required: true,
    maxlength: 500
  },
  metadata: {
    gameId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Game'
    },
    score: Number,
    accuracy: Number,
    playTime: Number,
    
    // For withdrawals
    bankAccount: {
      bankName: String,
      accountNumber: String,
      accountHolder: String,
      swiftCode: String
    },
    walletAddress: String,
    
    // For payments
    paymentMethod: {
      type: String,
      enum: ['stripe', 'epcm', 'bank_transfer', 'crypto', 'paypal']
    },
    paymentId: String,
    paymentData: mongoose.Schema.Types.Mixed,
    
    // Fee information
    fees: {
      platform: {
        type: Number,
        default: 0
      },
      payment: {
        type: Number,
        default: 0
      },
      withdrawal: {
        type: Number,
        default: 0
      },
      total: {
        type: Number,
        default: 0
      }
    },
    
    // Exchange rates (for fiat conversions)
    exchangeRate: Number,
    originalAmount: Number,
    originalCurrency: String
  },
  payment: {
    gateway: {
      type: String,
      enum: ['stripe', 'epcm', 'manual']
    },
    gatewayTransactionId: String,
    gatewayResponse: mongoose.Schema.Types.Mixed,
    webhookReceived: {
      type: Boolean,
      default: false
    },
    webhookData: mongoose.Schema.Types.Mixed,
    
    // Retry mechanism
    retryCount: {
      type: Number,
      default: 0
    },
    maxRetries: {
      type: Number,
      default: 3
    },
    nextRetry: Date
  },
  verification: {
    required: {
      type: Boolean,
      default: false
    },
    kycLevel: {
      type: String,
      enum: ['basic', 'enhanced', 'full'],
      default: 'basic'
    },
    verified: {
      type: Boolean,
      default: false
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    verifiedAt: Date,
    
    // Anti-fraud checks
    riskScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    flagged: {
      type: Boolean,
      default: false
    },
    flagReason: String
  },
  audit: {
    createdBy: {
      type: String,
      enum: ['system', 'user', 'admin', 'api'],
      default: 'system'
    },
    ipAddress: String,
    userAgent: String,
    location: {
      country: String,
      city: String,
      coordinates: [Number]
    },
    sessionId: String,
    
    // Processing logs
    logs: [{
      timestamp: {
        type: Date,
        default: Date.now
      },
      action: String,
      status: String,
      message: String,
      data: mongoose.Schema.Types.Mixed
    }],
    
    // State changes
    statusHistory: [{
      from: String,
      to: String,
      timestamp: {
        type: Date,
        default: Date.now
      },
      reason: String,
      changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    }]
  },
  schedule: {
    executeAt: Date,
    recurring: {
      enabled: {
        type: Boolean,
        default: false
      },
      frequency: {
        type: String,
        enum: ['daily', 'weekly', 'monthly', 'yearly']
      },
      nextExecution: Date,
      endDate: Date
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtuals
transactionSchema.virtual('netAmount').get(function() {
  return this.amount - (this.metadata.fees?.total || 0);
});

transactionSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

transactionSchema.virtual('isPending').get(function() {
  return ['pending', 'processing'].includes(this.status);
});

transactionSchema.virtual('isFailed').get(function() {
  return ['failed', 'cancelled', 'expired'].includes(this.status);
});

transactionSchema.virtual('canRetry').get(function() {
  return this.isFailed && this.payment.retryCount < this.payment.maxRetries;
});

transactionSchema.virtual('formattedAmount').get(function() {
  const formatters = {
    'BIGCOIN': (amount) => `${amount.toFixed(4)} BC`,
    'USD': (amount) => `${amount.toFixed(2)}`,
    'VND': (amount) => `${amount.toLocaleString('vi-VN')} ₫`,
    'SGD': (amount) => `S${amount.toFixed(2)}`
  };
  
  return formatters[this.currency] ? formatters[this.currency](this.amount) : `${this.amount} ${this.currency}`;
});

// Indexes for performance
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });
transactionSchema.index({ transactionId: 1 }, { unique: true });
transactionSchema.index({ 'payment.gatewayTransactionId': 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ 'schedule.executeAt': 1 });

// Pre-save middleware
transactionSchema.pre('save', function(next) {
  // Generate transaction ID if new
  if (this.isNew && !this.transactionId) {
    this.transactionId = this.generateTransactionId();
  }
  
  // Calculate total fees
  if (this.metadata.fees) {
    this.metadata.fees.total = (this.metadata.fees.platform || 0) + 
                              (this.metadata.fees.payment || 0) + 
                              (this.metadata.fees.withdrawal || 0);
  }
  
  // Add status change to history
  if (this.isModified('status') && !this.isNew) {
    const previousStatus = this.constructor.findOne({ _id: this._id }).select('status');
    this.audit.statusHistory.push({
      from: previousStatus?.status || 'unknown',
      to: this.status,
      reason: 'Status updated'
    });
  }
  
  // Risk assessment for large transactions
  if (this.type === 'withdrawal' && this.amount > 1000) {
    this.verification.required = true;
    this.verification.riskScore = Math.min(100, this.verification.riskScore + 30);
  }
  
  // Auto-flag suspicious transactions
  if (this.verification.riskScore > 70) {
    this.verification.flagged = true;
    this.verification.flagReason = 'High risk score detected';
  }
  
  next();
});

// Instance methods
transactionSchema.methods.generateTransactionId = function() {
  const prefix = {
    'game_reward': 'GR',
    'withdrawal': 'WD',
    'deposit': 'DP',
    'bonus': 'BN',
    'referral': 'RF',
    'penalty': 'PN',
    'refund': 'RD',
    'fee': 'FE',
    'purchase': 'PU'
  };
  
  const typePrefix = prefix[this.type] || 'TX';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  
  return `${typePrefix}${timestamp}${random}`;
};

transactionSchema.methods.addLog = function(action, status, message, data = null) {
  this.audit.logs.push({
    action,
    status,
    message,
    data
  });
  return this.save();
};

transactionSchema.methods.updateStatus = function(newStatus, reason = '', changedBy = null) {
  const oldStatus = this.status;
  this.status = newStatus;
  
  this.audit.statusHistory.push({
    from: oldStatus,
    to: newStatus,
    reason,
    changedBy
  });
  
  return this.addLog('status_change', newStatus, `Status changed from ${oldStatus} to ${newStatus}: ${reason}`);
};

transactionSchema.methods.markCompleted = function(gatewayResponse = null) {
  this.status = 'completed';
  if (gatewayResponse) {
    this.payment.gatewayResponse = gatewayResponse;
  }
  
  return this.addLog('completed', 'success', 'Transaction completed successfully');
};

transactionSchema.methods.markFailed = function(reason, errorData = null) {
  this.status = 'failed';
  
  // Schedule retry if applicable
  if (this.canRetry) {
    this.payment.retryCount += 1;
    this.payment.nextRetry = new Date(Date.now() + (this.payment.retryCount * 30 * 60 * 1000)); // Exponential backoff
  }
  
  return this.addLog('failed', 'error', reason, errorData);
};

transactionSchema.methods.processPayment = async function() {
  try {
    this.status = 'processing';
    await this.addLog('payment_started', 'processing', 'Payment processing initiated');
    
    let result;
    
    switch (this.payment.gateway) {
      case 'stripe':
        result = await this.processStripePayment();
        break;
      case 'epcm':
        result = await this.processEpcmPayment();
        break;
      default:
        throw new Error('Unsupported payment gateway');
    }
    
    if (result.success) {
      this.payment.gatewayTransactionId = result.transactionId;
      await this.markCompleted(result.data);
    } else {
      await this.markFailed(result.error, result.data);
    }
    
    return result;
    
  } catch (error) {
    await this.markFailed(error.message, { error: error.stack });
    throw error;
  }
};

transactionSchema.methods.processStripePayment = async function() {
  // Implementation placeholder - actual Stripe integration would go here
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  
  try {
    if (this.type === 'withdrawal') {
      // Process payout
      const payout = await stripe.payouts.create({
        amount: Math.round(this.netAmount * 100), // Stripe uses cents
        currency: this.currency.toLowerCase(),
        description: this.description,
        metadata: {
          transactionId: this.transactionId,
          userId: this.userId.toString()
        }
      });
      
      return {
        success: true,
        transactionId: payout.id,
        data: payout
      };
    } else if (this.type === 'deposit') {
      // Process payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(this.amount * 100),
        currency: this.currency.toLowerCase(),
        description: this.description,
        metadata: {
          transactionId: this.transactionId,
          userId: this.userId.toString()
        }
      });
      
      return {
        success: true,
        transactionId: paymentIntent.id,
        data: paymentIntent
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      data: error
    };
  }
};

transactionSchema.methods.processEpcmPayment = async function() {
  // Implementation placeholder - actual ePCM integration would go here
  const axios = require('axios');
  
  try {
    const response = await axios.post(`${process.env.EPCM_API_URL}/payments`, {
      merchant_id: process.env.EPCM_MERCHANT_ID,
      amount: this.amount,
      currency: this.currency,
      description: this.description,
      transaction_id: this.transactionId,
      user_id: this.userId.toString()
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.EPCM_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      success: response.data.status === 'success',
      transactionId: response.data.transaction_id,
      data: response.data
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      data: error.response?.data
    };
  }
};

transactionSchema.methods.calculateFees = function() {
  const fees = {
    platform: 0,
    payment: 0,
    withdrawal: 0,
    total: 0
  };
  
  if (this.type === 'withdrawal') {
    // Platform withdrawal fee
    fees.withdrawal = this.amount * (parseFloat(process.env.WITHDRAWAL_FEE) || 0.05);
    
    // Payment gateway fees
    if (this.payment.gateway === 'stripe') {
      fees.payment = Math.max(0.30, this.amount * 0.029); // Stripe fee structure
    } else if (this.payment.gateway === 'epcm') {
      fees.payment = this.amount * 0.025; // ePCM fee
    }
  } else if (this.type === 'deposit') {
    // Payment processing fees
    if (this.payment.gateway === 'stripe') {
      fees.payment = Math.max(0.30, this.amount * 0.029);
    }
  }
  
  fees.total = fees.platform + fees.payment + fees.withdrawal;
  this.metadata.fees = fees;
  
  return fees;
};

transactionSchema.methods.canBeProcessed = function() {
  return this.status === 'pending' && 
         !this.verification.flagged && 
         (!this.verification.required || this.verification.verified);
};

// Static methods
transactionSchema.statics.createGameReward = async function(userId, gameId, amount, gameData) {
  const transaction = new this({
    userId,
    type: 'game_reward',
    amount,
    currency: 'BIGCOIN',
    description: `Game reward for score ${gameData.score}`,
    metadata: {
      gameId,
      score: gameData.score,
      accuracy: gameData.accuracy,
      playTime: gameData.playTime
    },
    audit: {
      createdBy: 'system'
    }
  });
  
  transaction.status = 'completed'; // Game rewards are instant
  return await transaction.save();
};

transactionSchema.statics.createWithdrawal = async function(userId, amount, method, accountInfo) {
  const fees = {};
  const withdrawalFee = amount * (parseFloat(process.env.WITHDRAWAL_FEE) || 0.05);
  
  fees.withdrawal = withdrawalFee;
  fees.total = withdrawalFee;
  
  const transaction = new this({
    userId,
    type: 'withdrawal',
    amount: amount - fees.total, // Net amount after fees
    currency: 'BIGCOIN',
    description: `Withdrawal to ${method}`,
    metadata: {
      fees,
      paymentMethod: method,
      bankAccount: method === 'bank_transfer' ? accountInfo : undefined,
      walletAddress: method === 'crypto' ? accountInfo.address : undefined
    },
    payment: {
      gateway: method === 'bank_transfer' ? 'epcm' : 'stripe'
    },
    verification: {
      required: amount > 100,
      kycLevel: amount > 1000 ? 'enhanced' : 'basic'
    },
    audit: {
      createdBy: 'user'
    }
  });
  
  return await transaction.save();
};

transactionSchema.statics.getUserBalance = async function(userId) {
  const result = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        status: 'completed'
      }
    },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' }
      }
    }
  ]);
  
  let balance = 0;
  result.forEach(item => {
    if (['game_reward', 'deposit', 'bonus', 'referral', 'refund'].includes(item._id)) {
      balance += item.total;
    } else if (['withdrawal', 'penalty', 'fee', 'purchase'].includes(item._id)) {
      balance -= item.total;
    }
  });
  
  return Math.max(0, balance);
};

transactionSchema.statics.getTransactionHistory = async function(userId, filters = {}) {
  const query = { userId, ...filters };
  
  return await this.find(query)
    .sort({ createdAt: -1 })
    .populate('metadata.gameId', 'musicId scoring')
    .limit(100);
};

transactionSchema.statics.getPendingWithdrawals = async function() {
  return await this.find({
    type: 'withdrawal',
    status: { $in: ['pending', 'processing'] }
  }).populate('userId', 'username email kyc');
};

transactionSchema.statics.getDailyStats = async function(date = new Date()) {
  const startOfDay = new Date(date.setHours(0, 0, 0, 0));
  const endOfDay = new Date(date.setHours(23, 59, 59, 999));
  
  return await this.aggregate([
    {
      $match: {
        createdAt: { $gte: startOfDay, $lte: endOfDay },
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
};

module.exports = mongoose.model('Transaction', transactionSchema);