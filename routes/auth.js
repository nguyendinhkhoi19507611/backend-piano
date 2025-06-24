
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require("crypto");
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticateToken, generateToken, refreshToken, logout } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const validator = require('validator');

const router = express.Router();

// Rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Limit each IP to 3 registration attempts per hour
  message: {
    success: false,
    message: 'Too many registration attempts, please try again later.'
  }
});

// @route   POST /api/auth/register
// @desc    Register new user
// @access  Public
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username, email, and password are required'
      });
    }

    // Validate email format
    if (!validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    // Validate password strength
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    // Validate username format
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: existingUser.email === email ? 'Email already registered' : 'Username already taken'
      });
    }

    // Handle referral code
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ 'referral.code': referralCode.toUpperCase() });
      if (referrer) {
        referredBy = referrer._id;
      }
    }

    // Create new user
    const user = new User({
      username,
      email: email.toLowerCase(),
      password,
      referral: {
        referredBy
      },
      security: {
        loginHistory: [{
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.get('User-Agent'),
          location: req.headers['x-user-location'] || 'Unknown'
        }]
      }
    });

    await user.save();

    // Generate JWT token
    const token = generateToken(user._id);

    // Process referral bonus if applicable
    if (referredBy) {
      try {
        const PaymentService = require('../services/paymentService');
        await PaymentService.processReferralBonus(referredBy, user._id);
      } catch (referralError) {
        console.error('Referral bonus error:', referralError);
        // Don't fail registration if referral processing fails
      }
    }

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        level: user.statistics.level,
        coins: user.coins,
        preferences: user.preferences
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during registration'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user and authenticate
    const user = await User.findByCredentials(email, password);
    
    // Update login information
    user.security.lastLogin = new Date();
    user.security.loginHistory.unshift({
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent'),
      location: req.headers['x-user-location'] || 'Unknown'
    });

    // Keep only last 10 login records
    if (user.security.loginHistory.length > 10) {
      user.security.loginHistory = user.security.loginHistory.slice(0, 10);
    }

    await user.save();

    // Generate tokens
    const accessToken = generateToken(user._id);
    const refreshTokenValue = jwt.sign(
      { userId: user._id },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      accessToken,
      refreshToken: refreshTokenValue,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        level: user.statistics.level,
        coins: user.coins,
        preferences: user.preferences,
        kycStatus: user.kyc.status,
        premiumActive: user.subscriptions.premium.active,
        isShowAds: user.isShowAds,
        statistics: {
          totalGames: user.statistics.totalGames,
          totalScore: user.statistics.totalScore,
          bestScore: user.statistics.bestScore,
          totalPlayTime: user.statistics.totalPlayTime,
          favoriteGenre: user.statistics.favoriteGenre,
          level: user.statistics.level,
          experience: user.statistics.experience,
          accuracy: user.statistics.accuracy
        }
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    
    if (error.message.includes('Invalid credentials') || 
        error.message.includes('Account locked')) {
      return res.status(401).json({
        success: false,
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error during login'
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh access token
// @access  Public
router.post('/refresh', refreshToken);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', authenticateToken, logout);

// @route   GET /api/auth/me
// @desc    Get current user profile
// @access  Private
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password -security.twoFactorSecret');

    res.json({
      success: true,
      user
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving user profile'
    });
  }
});

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    // giải mã req.body with key
      
    const { username, preferences, personalInfo, coins, statistics } = req.body;
    const user = await User.findById(req.user._id);

    // Update username if provided and available
    if (username && username !== user.username) {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: 'Username already taken'
        });
      }
      user.username = username;
    }

    // Update preferences
    if (preferences) {
      if (preferences.language) user.preferences.language = preferences.language;
      if (typeof preferences.soundEnabled === 'boolean') user.preferences.soundEnabled = preferences.soundEnabled;
      if (preferences.musicVolume !== undefined) user.preferences.musicVolume = Math.max(0, Math.min(100, preferences.musicVolume));
      if (preferences.effectsVolume !== undefined) user.preferences.effectsVolume = Math.max(0, Math.min(100, preferences.effectsVolume));
      if (typeof preferences.autoPlay === 'boolean') user.preferences.autoPlay = preferences.autoPlay;
    }

    // update coins 
    if (coins) {
      if (typeof coins.total === 'number' && coins.total >= 0) {
        user.coins.total = coins.total;
      }
      if (typeof coins.available === 'number' && coins.available >= 0) {
        user.coins.available = coins.available;
      }
      if (typeof coins.pending === 'number' && coins.pending >= 0) {
        user.coins.pending = coins.pending;
      }
    }
// statistics: {
//     totalGames: {
//       type: Number,
//       default: 0
//     },
//     totalScore: {
//       type: Number,
//       default: 0
//     },
//     bestScore: {
//       type: Number,
//       default: 0
//     },
//     totalPlayTime: {
//       type: Number,
//       default: 0 // Tính bằng phút
//     },
//     favoriteGenre: {
//       type: String,
//       default: null
//     },
//     level: {
//       type: Number,
//       default: 1,
//       min: 1
//     },
//     experience: {
//       type: Number,
//       default: 0,
//       min: 0
//     }
//   },
    // Update statistics
    if (statistics) {
      if (typeof statistics.totalGames === 'number' && statistics.totalGames >= 0) {
        user.statistics.totalGames = statistics.totalGames;
      }
      if (typeof statistics.experience === 'number' && statistics.experience >= 0) {
        user.statistics.experience = statistics.experience;
      }
      if (typeof statistics.bestScore === 'number' && statistics.bestScore >= 0) {
        user.statistics.bestScore = statistics.bestScore;
      }
      if (typeof statistics.accuracy === 'number' && statistics.accuracy >= 0) {
        user.statistics.accuracy = statistics.accuracy;
      }
    }

    // Update personal info for KYC
    if (personalInfo && user.kyc.status === 'not_submitted') {
      user.kyc.personalInfo = {
        ...user.kyc.personalInfo,
        ...personalInfo
      };
    }

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        preferences: user.preferences,
        kycStatus: user.kyc.status,
        coins: user.coins,
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile'
    });
  }
});

// @route   POST /api/auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Error changing password'
    });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Request password reset
// @access  Public
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always return success to prevent email enumeration
    res.json({
      success: true,
      message: 'If an account with that email exists, we have sent a password reset link'
    });

    // Send reset email if user exists (implement email service)
    if (user) {
      // TODO: Implement email service for password reset
      console.log(`Password reset requested for user: ${user.email}`);
    }

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing password reset request'
    });
  }
});

// @route   GET /api/auth/check-username/:username
// @desc    Check if username is available
// @access  Public
router.get('/check-username/:username', async (req, res) => {
  try {
    const { username } = req.params;

    if (!username || username.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Username must be at least 3 characters long'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }

    const existingUser = await User.findOne({ username });

    res.json({
      success: true,
      available: !existingUser,
      message: existingUser ? 'Username is already taken' : 'Username is available'
    });

  } catch (error) {
    console.error('Check username error:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking username availability'
    });
  }
});

// @route   GET /api/auth/verify-referral/:code
// @desc    Verify referral code
// @access  Public
router.get('/verify-referral/:code', async (req, res) => {
  try {
    const { code } = req.params;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Referral code is required'
      });
    }

    const referrer = await User.findOne({ 'referral.code': code.toUpperCase() })
      .select('username referral.code');

    if (!referrer) {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code'
      });
    }

    res.json({
      success: true,
      valid: true,
      referrer: {
        username: referrer.username,
        code: referrer.referral.code
      },
      bonus: 100 // Bonus amount for successful referral
    });

  } catch (error) {
    console.error('Verify referral error:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying referral code'
    });
  }
});

// @route   DELETE /api/auth/account
// @desc    Delete user account
// @access  Private
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password confirmation is required'
      });
    }

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Password is incorrect'
      });
    }

    // Check for pending transactions
    const Transaction = require('../models/Transaction');
    const pendingTransactions = await Transaction.find({
      userId: user._id,
      status: { $in: ['pending', 'processing'] }
    });

    if (pendingTransactions.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete account with pending transactions'
      });
    }

    // Soft delete - mark as deleted instead of removing
    user.status = 'deleted';
    user.email = `deleted_${Date.now()}_${user.email}`;
    user.username = `deleted_${Date.now()}_${user.username}`;
    await user.save();

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting account'
    });
  }
});

module.exports = router;