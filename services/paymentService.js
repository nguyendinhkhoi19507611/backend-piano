// services/paymentService.js - Payment processing and financial operations
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const crypto = require('crypto');

class PaymentService {

  // Process withdrawal request
  static async processWithdrawal(userId, amount, method, accountInfo) {
    try {
      // Validate user and amount
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.canWithdraw(amount)) {
        throw new Error('Withdrawal not allowed. Check KYC status and minimum amount.');
      }

      // Check sufficient balance
      const currentBalance = await Transaction.getUserBalance(userId);
      if (currentBalance < amount) {
        throw new Error('Insufficient balance');
      }

      // Create withdrawal transaction
      const transaction = await Transaction.createWithdrawal(
        userId, 
        amount, 
        method, 
        accountInfo
      );

      // Deduct coins from user account (put in pending)
      await user.deductCoins(amount, 'withdrawal_pending');
      user.coins.pending += amount;
      await user.save();

      // Process payment based on method
      let result;
      switch (method) {
        case 'bank_transfer':
          result = await this.processBankTransfer(transaction);
          break;
        case 'crypto':
          result = await this.processCryptoWithdrawal(transaction);
          break;
        case 'paypal':
          result = await this.processPayPalWithdrawal(transaction);
          break;
        default:
          throw new Error('Unsupported withdrawal method');
      }

      if (result.success) {
        await transaction.markCompleted(result.data);
        
        // Move from pending to completed
        user.coins.pending -= amount;
        await user.save();
      } else {
        await transaction.markFailed(result.error);
        
        // Refund to available balance
        user.coins.available += amount;
        user.coins.pending -= amount;
        await user.save();
      }

      return {
        success: result.success,
        transactionId: transaction.transactionId,
        message: result.success ? 'Withdrawal processed successfully' : result.error,
        estimatedTime: this.getEstimatedProcessingTime(method)
      };

    } catch (error) {
      throw new Error(`Withdrawal failed: ${error.message}`);
    }
  }

  // Process bank transfer via ePCM
  static async processBankTransfer(transaction) {
    try {
      const response = await axios.post(`${process.env.EPCM_API_URL}/transfers`, {
        merchant_id: process.env.EPCM_MERCHANT_ID,
        amount: transaction.netAmount,
        currency: 'SGD', // ePCM Singapore
        recipient: {
          bank_name: transaction.metadata.bankAccount.bankName,
          account_number: transaction.metadata.bankAccount.accountNumber,
          account_holder: transaction.metadata.bankAccount.accountHolder,
          swift_code: transaction.metadata.bankAccount.swiftCode
        },
        reference: transaction.transactionId,
        description: `BigCoin withdrawal - ${transaction.transactionId}`
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.EPCM_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.data.status === 'success') {
        return {
          success: true,
          transactionId: response.data.transfer_id,
          data: response.data
        };
      } else {
        return {
          success: false,
          error: response.data.message || 'Transfer failed',
          data: response.data
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        data: error.response?.data
      };
    }
  }

  // Process crypto withdrawal
  static async processCryptoWithdrawal(transaction) {
    try {
      // For demo purposes - in production, integrate with actual crypto wallet service
      const walletAddress = transaction.metadata.walletAddress;
      
      // Validate wallet address format
      if (!this.validateWalletAddress(walletAddress)) {
        return {
          success: false,
          error: 'Invalid wallet address format'
        };
      }

      // Simulate crypto transfer (replace with actual blockchain integration)
      const transferId = crypto.randomUUID();
      
      // In production, use actual crypto wallet API
      const cryptoResult = {
        success: true,
        transfer_id: transferId,
        wallet_address: walletAddress,
        amount: transaction.netAmount,
        currency: 'USDT', // Example stablecoin
        network: 'ERC20',
        tx_hash: `0x${crypto.randomBytes(32).toString('hex')}`,
        confirmations: 0
      };

      return {
        success: true,
        transactionId: transferId,
        data: cryptoResult
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process PayPal withdrawal
  static async processPayPalWithdrawal(transaction) {
    try {
      // PayPal Payouts API integration
      const payoutData = {
        sender_batch_header: {
          sender_batch_id: transaction.transactionId,
          email_subject: "BigCoin Withdrawal",
          email_message: "You have received a withdrawal from BigCoin!"
        },
        items: [{
          recipient_type: "EMAIL",
          amount: {
            value: transaction.netAmount.toFixed(2),
            currency: "USD"
          },
          receiver: transaction.metadata.paypalEmail,
          note: `BigCoin withdrawal - ${transaction.transactionId}`,
          sender_item_id: transaction.transactionId
        }]
      };

      // Note: PayPal SDK integration would go here
      // For demo, simulate successful response
      const paypalResult = {
        batch_header: {
          payout_batch_id: crypto.randomUUID(),
          batch_status: "PENDING"
        }
      };

      return {
        success: true,
        transactionId: paypalResult.batch_header.payout_batch_id,
        data: paypalResult
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Process deposit (for premium subscriptions)
  static async processDeposit(userId, amount, paymentMethodId, currency = 'USD') {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Create payment intent with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Stripe uses cents
        currency: currency.toLowerCase(),
        payment_method: paymentMethodId,
        confirmation_method: 'manual',
        confirm: true,
        description: `BigCoin deposit - User: ${user.username}`,
        metadata: {
          userId: userId.toString(),
          type: 'deposit'
        }
      });

      // Create transaction record
      const transaction = new Transaction({
        userId,
        type: 'deposit',
        amount,
        currency,
        description: `Deposit via ${paymentIntent.payment_method.type}`,
        status: 'processing',
        payment: {
          gateway: 'stripe',
          gatewayTransactionId: paymentIntent.id
        },
        metadata: {
          paymentMethod: paymentIntent.payment_method.type,
          paymentId: paymentIntent.id
        }
      });

      await transaction.save();

      if (paymentIntent.status === 'succeeded') {
        await transaction.markCompleted();
        
        // Convert to BigCoin (example rate: 1 USD = 100 BigCoin)
        const bigCoinAmount = amount * 100;
        await user.addCoins(bigCoinAmount, 'deposit');

        return {
          success: true,
          transactionId: transaction.transactionId,
          paymentIntent,
          coinsAdded: bigCoinAmount
        };
      } else {
        return {
          success: false,
          error: 'Payment failed',
          paymentIntent,
          requiresAction: paymentIntent.status === 'requires_action'
        };
      }

    } catch (error) {
      throw new Error(`Deposit failed: ${error.message}`);
    }
  }

  // Handle Stripe webhooks
  static async handleStripeWebhook(event) {
    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentSuccess(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailure(event.data.object);
          break;
        case 'payout.paid':
          await this.handlePayoutSuccess(event.data.object);
          break;
        case 'payout.failed':
          await this.handlePayoutFailure(event.data.object);
          break;
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      return { success: true };

    } catch (error) {
      console.error('Webhook processing error:', error);
      return { success: false, error: error.message };
    }
  }

  // Handle successful payment
  static async handlePaymentSuccess(paymentIntent) {
    const transaction = await Transaction.findOne({
      'payment.gatewayTransactionId': paymentIntent.id
    });

    if (transaction && transaction.status === 'processing') {
      await transaction.markCompleted(paymentIntent);
      
      if (transaction.type === 'deposit') {
        const bigCoinAmount = transaction.amount * 100; // Convert to BigCoin
        const user = await User.findById(transaction.userId);
        await user.addCoins(bigCoinAmount, 'deposit');
      }
    }
  }

  // Handle failed payment
  static async handlePaymentFailure(paymentIntent) {
    const transaction = await Transaction.findOne({
      'payment.gatewayTransactionId': paymentIntent.id
    });

    if (transaction && transaction.isPending) {
      await transaction.markFailed('Payment failed', paymentIntent);
      
      // Refund coins if withdrawal
      if (transaction.type === 'withdrawal') {
        const user = await User.findById(transaction.userId);
        user.coins.available += transaction.amount;
        user.coins.pending -= transaction.amount;
        await user.save();
      }
    }
  }

  // Get exchange rates
  static async getExchangeRates() {
    try {
      // In production, use actual exchange rate API
      return {
        'USD': 1,
        'VND': 24000,
        'SGD': 1.35,
        'BIGCOIN': 0.01 // 1 BIGCOIN = 0.01 USD
      };
    } catch (error) {
      throw new Error('Failed to get exchange rates');
    }
  }

  // Convert currency
  static async convertCurrency(amount, fromCurrency, toCurrency) {
    const rates = await this.getExchangeRates();
    
    if (!rates[fromCurrency] || !rates[toCurrency]) {
      throw new Error('Unsupported currency');
    }

    // Convert to USD first, then to target currency
    const usdAmount = amount / rates[fromCurrency];
    const convertedAmount = usdAmount * rates[toCurrency];

    return {
      originalAmount: amount,
      originalCurrency: fromCurrency,
      convertedAmount: convertedAmount,
      targetCurrency: toCurrency,
      exchangeRate: rates[toCurrency] / rates[fromCurrency]
    };
  }

  // Validate wallet address
  static validateWalletAddress(address) {
    // Basic validation for common crypto wallet formats
    const patterns = {
      bitcoin: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
      ethereum: /^0x[a-fA-F0-9]{40}$/,
      usdt_erc20: /^0x[a-fA-F0-9]{40}$/
    };

    return Object.values(patterns).some(pattern => pattern.test(address));
  }

  // Get processing time estimates
  static getEstimatedProcessingTime(method) {
    const times = {
      'bank_transfer': '1-3 business days',
      'crypto': '10-30 minutes',
      'paypal': '2-5 business days'
    };

    return times[method] || 'Unknown';
  }

  // Calculate fees
  static calculateFees(amount, type, method) {
    const fees = {
      platform: 0,
      payment: 0,
      total: 0
    };

    if (type === 'withdrawal') {
      // Platform fee
      fees.platform = amount * 0.02; // 2%
      
      // Method-specific fees
      switch (method) {
        case 'bank_transfer':
          fees.payment = 5; // Fixed $5 fee
          break;
        case 'crypto':
          fees.payment = amount * 0.01; // 1%
          break;
        case 'paypal':
          fees.payment = amount * 0.025; // 2.5%
          break;
      }
    } else if (type === 'deposit') {
      // Stripe fees
      fees.payment = Math.max(0.30, amount * 0.029);
    }

    fees.total = fees.platform + fees.payment;
    return fees;
  }

  // Get user transaction history
  static async getTransactionHistory(userId, filters = {}) {
    try {
      return await Transaction.getTransactionHistory(userId, filters);
    } catch (error) {
      throw new Error(`Failed to get transaction history: ${error.message}`);
    }
  }

  // Get pending withdrawals (admin)
  static async getPendingWithdrawals() {
    try {
      return await Transaction.getPendingWithdrawals();
    } catch (error) {
      throw new Error(`Failed to get pending withdrawals: ${error.message}`);
    }
  }

  // Approve withdrawal (admin)
  static async approveWithdrawal(transactionId, adminId) {
    try {
      const transaction = await Transaction.findOne({
        transactionId,
        type: 'withdrawal',
        status: 'pending'
      });

      if (!transaction) {
        throw new Error('Transaction not found or already processed');
      }

      // Process the withdrawal
      const result = await transaction.processPayment();
      
      await transaction.addLog(
        'admin_approval', 
        'approved', 
        'Withdrawal approved by admin',
        { adminId }
      );

      return {
        success: result.success,
        message: result.success ? 'Withdrawal approved and processed' : 'Withdrawal approved but processing failed'
      };

    } catch (error) {
      throw new Error(`Failed to approve withdrawal: ${error.message}`);
    }
  }

  // Reject withdrawal (admin)
  static async rejectWithdrawal(transactionId, reason, adminId) {
    try {
      const transaction = await Transaction.findOne({
        transactionId,
        type: 'withdrawal',
        status: 'pending'
      });

      if (!transaction) {
        throw new Error('Transaction not found or already processed');
      }

      await transaction.updateStatus('cancelled', reason, adminId);
      
      // Refund coins to user
      const user = await User.findById(transaction.userId);
      user.coins.available += transaction.amount;
      user.coins.pending -= transaction.amount;
      await user.save();

      return {
        success: true,
        message: 'Withdrawal rejected and coins refunded'
      };

    } catch (error) {
      throw new Error(`Failed to reject withdrawal: ${error.message}`);
    }
  }

  // Process premium subscription payment
  static async processPremiumSubscription(userId, plan, paymentMethodId) {
    try {
      const plans = {
        'basic': { price: 9.99, duration: 30 },
        'premium': { price: 19.99, duration: 30 },
        'vip': { price: 49.99, duration: 30 }
      };

      const selectedPlan = plans[plan];
      if (!selectedPlan) {
        throw new Error('Invalid subscription plan');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Create Stripe subscription
      const subscription = await stripe.subscriptions.create({
        customer: user.stripeCustomerId || await this.createStripeCustomer(user),
        items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `BigCoin ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`,
              description: `${selectedPlan.duration} days of premium access`
            },
            unit_amount: Math.round(selectedPlan.price * 100),
            recurring: {
              interval: 'month'
            }
          }
        }],
        payment_behavior: 'default_incomplete',
        expand: ['latest_invoice.payment_intent']
      });

      // Update user subscription
      user.subscriptions.premium = {
        active: true,
        plan,
        expiresAt: new Date(Date.now() + selectedPlan.duration * 24 * 60 * 60 * 1000)
      };
      await user.save();

      // Create transaction record
      const transaction = new Transaction({
        userId,
        type: 'purchase',
        amount: selectedPlan.price,
        currency: 'USD',
        description: `Premium subscription - ${plan}`,
        status: 'completed',
        payment: {
          gateway: 'stripe',
          gatewayTransactionId: subscription.id
        },
        metadata: {
          subscriptionPlan: plan,
          subscriptionId: subscription.id
        }
      });

      await transaction.save();

      return {
        success: true,
        subscription,
        transactionId: transaction.transactionId
      };

    } catch (error) {
      throw new Error(`Subscription failed: ${error.message}`);
    }
  }

  // Create Stripe customer
  static async createStripeCustomer(user) {
    try {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.username,
        metadata: {
          userId: user._id.toString()
        }
      });

      user.stripeCustomerId = customer.id;
      await user.save();

      return customer.id;

    } catch (error) {
      throw new Error(`Failed to create Stripe customer: ${error.message}`);
    }
  }

  // Cancel subscription
  static async cancelSubscription(userId) {
    try {
      const user = await User.findById(userId);
      if (!user || !user.subscriptions.premium.active) {
        throw new Error('No active subscription found');
      }

      // Find subscription transaction
      const transaction = await Transaction.findOne({
        userId,
        type: 'purchase',
        'metadata.subscriptionPlan': { $exists: true },
        status: 'completed'
      }).sort({ createdAt: -1 });

      if (transaction && transaction.metadata.subscriptionId) {
        // Cancel Stripe subscription
        await stripe.subscriptions.del(transaction.metadata.subscriptionId);
      }

      // Update user subscription
      user.subscriptions.premium.active = false;
      await user.save();

      return {
        success: true,
        message: 'Subscription cancelled successfully'
      };

    } catch (error) {
      throw new Error(`Failed to cancel subscription: ${error.message}`);
    }
  }

  // Process referral bonus
  static async processReferralBonus(referrerId, newUserId) {
    try {
      const referrer = await User.findById(referrerId);
      const newUser = await User.findById(newUserId);

      if (!referrer || !newUser) {
        throw new Error('User(s) not found');
      }

      const bonusAmount = 100; // 100 BigCoins for successful referral

      // Add bonus to referrer
      await referrer.addCoins(bonusAmount, 'referral');

      // Update referral record
      referrer.referral.referredUsers.push({
        user: newUserId,
        bonus: bonusAmount
      });
      await referrer.save();

      // Create transaction record
      const transaction = new Transaction({
        userId: referrerId,
        type: 'referral',
        amount: bonusAmount,
        currency: 'BIGCOIN',
        description: `Referral bonus for inviting ${newUser.username}`,
        status: 'completed',
        metadata: {
          referredUserId: newUserId,
          referredUsername: newUser.username
        }
      });

      await transaction.save();

      return {
        success: true,
        bonusAmount,
        transactionId: transaction.transactionId
      };

    } catch (error) {
      throw new Error(`Failed to process referral bonus: ${error.message}`);
    }
  }

  // Generate financial report
  static async generateFinancialReport(period = '30d') {
    try {
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
      }

      const stats = await Transaction.aggregate([
        {
          $match: {
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

      const dailyStats = await Transaction.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
            status: 'completed'
          }
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
            },
            transactions: { $sum: 1 },
            volume: { $sum: '$amount' }
          }
        },
        {
          $sort: { '_id': 1 }
        }
      ]);

      // Calculate revenue streams
      let totalRevenue = 0;
      let totalWithdrawals = 0;
      let totalDeposits = 0;

      stats.forEach(stat => {
        switch (stat._id) {
          case 'purchase':
          case 'fee':
            totalRevenue += stat.totalAmount;
            break;
          case 'withdrawal':
            totalWithdrawals += stat.totalAmount;
            break;
          case 'deposit':
            totalDeposits += stat.totalAmount;
            break;
        }
      });

      return {
        success: true,
        period,
        summary: {
          totalRevenue,
          totalWithdrawals,
          totalDeposits,
          netFlow: totalDeposits - totalWithdrawals,
          transactionCount: stats.reduce((sum, stat) => sum + stat.count, 0)
        },
        byType: stats,
        dailyTrend: dailyStats
      };

    } catch (error) {
      throw new Error(`Failed to generate financial report: ${error.message}`);
    }
  }

  // Verify KYC status for large transactions
  static async verifyKYCForTransaction(userId, amount, type) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const kycRequired = {
        basic: 100,    // $100 limit without KYC
        enhanced: 1000, // $1000 limit with basic KYC
        full: 10000     // $10000 limit with enhanced KYC
      };

      let requiredLevel = 'none';
      
      if (amount >= kycRequired.full) {
        requiredLevel = 'full';
      } else if (amount >= kycRequired.enhanced) {
        requiredLevel = 'enhanced';
      } else if (amount >= kycRequired.basic) {
        requiredLevel = 'basic';
      }

      const currentLevel = user.kyc.status === 'verified' ? 'enhanced' : 'none';

      return {
        allowed: this.compareKYCLevels(currentLevel, requiredLevel),
        currentLevel,
        requiredLevel,
        kycStatus: user.kyc.status
      };

    } catch (error) {
      throw new Error(`KYC verification failed: ${error.message}`);
    }
  }

  // Compare KYC levels
  static compareKYCLevels(current, required) {
    const levels = ['none', 'basic', 'enhanced', 'full'];
    return levels.indexOf(current) >= levels.indexOf(required);
  }

  // Process batch withdrawals (admin function)
  static async processBatchWithdrawals(transactionIds, adminId) {
    const results = [];

    for (const transactionId of transactionIds) {
      try {
        const result = await this.approveWithdrawal(transactionId, adminId);
        results.push({
          transactionId,
          success: result.success,
          message: result.message
        });
      } catch (error) {
        results.push({
          transactionId,
          success: false,
          message: error.message
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    return {
      success: true,
      processed: results.length,
      successful: successCount,
      failed: failCount,
      results
    };
  }

  // Handle cryptocurrency price updates
  static async updateCryptoPrices() {
    try {
      // In production, integrate with CoinGecko, CoinMarketCap, etc.
      const mockPrices = {
        'BTC': 45000,
        'ETH': 3000,
        'USDT': 1,
        'BIGCOIN': 0.01
      };

      // Store in cache or database for exchange rate calculations
      global.cryptoPrices = mockPrices;
      
      return {
        success: true,
        prices: mockPrices,
        updatedAt: new Date()
      };

    } catch (error) {
      throw new Error(`Failed to update crypto prices: ${error.message}`);
    }
  }

  // Monitor suspicious activities
  static async monitorSuspiciousActivity(userId, transactionData) {
    try {
      const user = await User.findById(userId);
      const recentTransactions = await Transaction.find({
        userId,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
      });

      let riskScore = 0;
      const flags = [];

      // Check for rapid successive withdrawals
      const recentWithdrawals = recentTransactions.filter(t => t.type === 'withdrawal');
      if (recentWithdrawals.length > 3) {
        riskScore += 30;
        flags.push('Multiple withdrawals in 24h');
      }

      // Check for unusual amounts
      const userAvgTransaction = await Transaction.aggregate([
        { $match: { userId, type: transactionData.type } },
        { $group: { _id: null, avgAmount: { $avg: '$amount' } } }
      ]);

      if (userAvgTransaction.length > 0) {
        const avgAmount = userAvgTransaction[0].avgAmount;
        if (transactionData.amount > avgAmount * 5) {
          riskScore += 25;
          flags.push('Amount significantly higher than usual');
        }
      }

      // Check new account activity
      const accountAge = (new Date() - user.createdAt) / (1000 * 60 * 60 * 24); // Days
      if (accountAge < 7 && transactionData.amount > 500) {
        riskScore += 40;
        flags.push('Large transaction from new account');
      }

      // Check geographic inconsistency
      if (user.security.loginHistory.length > 0) {
        const lastLocation = user.security.loginHistory[0].location;
        if (transactionData.location && lastLocation !== transactionData.location) {
          riskScore += 20;
          flags.push('Transaction from different location');
        }
      }

      return {
        riskScore: Math.min(100, riskScore),
        flags,
        requiresReview: riskScore > 70,
        requiresApproval: riskScore > 50
      };

    } catch (error) {
      console.error('Risk monitoring error:', error);
      return {
        riskScore: 50,
        flags: ['Error in risk assessment'],
        requiresReview: true,
        requiresApproval: false
      };
    }
  }
}

module.exports = PaymentService;