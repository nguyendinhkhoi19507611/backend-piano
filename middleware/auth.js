// middleware/auth.js - JWT authentication and authorization middleware
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Verify JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token is required'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if account is active
    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Account is not active'
      });
    }

    // Check if account is locked
    if (user.security.accountLocked && user.security.lockedUntil > new Date()) {
      return res.status(423).json({
        success: false,
        message: 'Account is temporarily locked',
        lockedUntil: user.security.lockedUntil
      });
    }

    // Update last login if different session
    if (!req.headers['x-session-id'] || req.headers['x-session-id'] !== user.security.sessionId) {
      user.security.lastLogin = new Date();
      
      // Add login history
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
    }

    req.user = user;
    next();
    
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    
    console.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Optional authentication (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('-password');
      
      if (user && user.status === 'active') {
        req.user = user;
      }
    }
    
    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};

// Check if user has required role/permission
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const userRole = req.user.role || 'user';
    
    if (!roles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }

    next();
  };
};

// Check KYC verification status
const requireKYC = (level = 'verified') => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const kycStatus = req.user.kyc.status;
    
    if (level === 'verified' && kycStatus !== 'verified') {
      return res.status(403).json({
        success: false,
        message: 'KYC verification required',
        kycStatus,
        redirectTo: '/kyc/verify'
      });
    }

    next();
  };
};

// Check premium subscription
const requirePremium = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required'
    });
  }

  const subscription = req.user.subscriptions.premium;
  
  if (!subscription.active || subscription.expiresAt < new Date()) {
    return res.status(403).json({
      success: false,
      message: 'Premium subscription required',
      upgradeUrl: '/premium/upgrade'
    });
  }

  next();
};

// Rate limiting based on user level
const userRateLimit = (req, res, next) => {
  if (!req.user) {
    return next();
  }

  const userLevel = req.user.statistics.level;
  const now = new Date();
  const windowStart = new Date(now.getTime() - 60000); // 1 minute window

  // Set rate limits based on user level
  let maxRequests = 30; // Default for level 1
  
  if (userLevel >= 10) maxRequests = 100;
  else if (userLevel >= 5) maxRequests = 60;

  // Store in memory cache (in production, use Redis)
  const userKey = `rate_limit_${req.user._id}`;
  if (!global.rateLimitCache) global.rateLimitCache = new Map();
  
  const userRequests = global.rateLimitCache.get(userKey) || [];
  const recentRequests = userRequests.filter(time => time > windowStart);
  
  if (recentRequests.length >= maxRequests) {
    return res.status(429).json({
      success: false,
      message: 'Rate limit exceeded',
      retryAfter: 60
    });
  }

  // Add current request
  recentRequests.push(now);
  global.rateLimitCache.set(userKey, recentRequests);

  next();
};

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Refresh token
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is required'
      });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user || user.status !== 'active') {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    const newAccessToken = generateToken(user._id);
    const newRefreshToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });

  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid refresh token'
    });
  }
};

// Logout (invalidate tokens)
const logout = async (req, res) => {
  try {
    // In a production environment, you would add the token to a blacklist
    // or store active sessions in Redis and remove them
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
    
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Error during logout'
    });
  }
};

// Check if user owns resource
const requireOwnership = (resourceModel, resourceParam = 'id') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[resourceParam];
      const resource = await resourceModel.findById(resourceId);
      
      if (!resource) {
        return res.status(404).json({
          success: false,
          message: 'Resource not found'
        });
      }
      
      if (resource.userId && resource.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
      
      req.resource = resource;
      next();
      
    } catch (error) {
      console.error('Ownership check error:', error);
      res.status(500).json({
        success: false,
        message: 'Error checking resource ownership'
      });
    }
  };
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  next();
};

module.exports = {
  authenticateToken,
  optionalAuth,
  requireRole,
  requireKYC,
  requirePremium,
  userRateLimit,
  generateToken,
  refreshToken,
  logout,
  requireOwnership,
  securityHeaders
};