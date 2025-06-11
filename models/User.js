
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [30, 'Username cannot exceed 30 characters'],
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers and underscores']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false // Không trả về password khi query
  },
  avatar: {
    type: String,
    default: null
  },
  coins: {
    total: {
      type: Number,
      default: 0,
      min: 0
    },
    available: {
      type: Number,
      default: 0,
      min: 0
    },
    pending: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  statistics: {
    totalGames: {
      type: Number,
      default: 0
    },
    totalScore: {
      type: Number,
      default: 0
    },
    bestScore: {
      type: Number,
      default: 0
    },
    totalPlayTime: {
      type: Number,
      default: 0 // Tính bằng phút
    },
    favoriteGenre: {
      type: String,
      default: null
    },
    level: {
      type: Number,
      default: 1,
      min: 1
    },
    experience: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  preferences: {
    language: {
      type: String,
      enum: ['en', 'vi'],
      default: 'en'
    },
    soundEnabled: {
      type: Boolean,
      default: true
    },
    musicVolume: {
      type: Number,
      default: 70,
      min: 0,
      max: 100
    },
    effectsVolume: {
      type: Number,
      default: 50,
      min: 0,
      max: 100
    },
    autoPlay: {
      type: Boolean,
      default: false
    }
  },
  kyc: {
    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected', 'not_submitted'],
      default: 'not_submitted'
    },
    submittedAt: Date,
    verifiedAt: Date,
    documents: [{
      type: {
        type: String,
        enum: ['id_card', 'passport', 'driving_license', 'address_proof']
      },
      url: String,
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
      },
      uploadedAt: {
        type: Date,
        default: Date.now
      }
    }],
    personalInfo: {
      fullName: String,
      dateOfBirth: Date,
      nationality: String,
      address: {
        street: String,
        city: String,
        state: String,
        postalCode: String,
        country: String
      },
      phoneNumber: String
    }
  },
  wallet: {
    address: String,
    provider: {
      type: String,
      enum: ['metamask', 'trust_wallet', 'coinbase_wallet']
    },
    connectedAt: Date
  },
  security: {
    lastLogin: Date,
    loginHistory: [{
      ip: String,
      userAgent: String,
      location: String,
      timestamp: {
        type: Date,
        default: Date.now
      }
    }],
    failedLoginAttempts: {
      type: Number,
      default: 0
    },
    accountLocked: {
      type: Boolean,
      default: false
    },
    lockedUntil: Date,
    twoFactorEnabled: {
      type: Boolean,
      default: false
    },
    twoFactorSecret: String
  },
  subscriptions: {
    premium: {
      active: {
        type: Boolean,
        default: false
      },
      expiresAt: Date,
      plan: {
        type: String,
        enum: ['basic', 'premium', 'vip']
      }
    },
    notifications: {
      email: {
        type: Boolean,
        default: true
      },
      push: {
        type: Boolean,
        default: true
      },
      gameUpdates: {
        type: Boolean,
        default: true
      },
      promotions: {
        type: Boolean,
        default: false
      }
    }
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'banned', 'deleted'],
    default: 'active'
  },
  referral: {
    code: {
      type: String,
      unique: true,
      sparse: true
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    referredUsers: [{
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      joinedAt: {
        type: Date,
        default: Date.now
      },
      bonus: {
        type: Number,
        default: 0
      }
    }]
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.password;
      delete ret.security.twoFactorSecret;
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Virtuals
userSchema.virtual('totalEarnings').get(function() {
  return this.coins.total;
});

userSchema.virtual('nextLevelExperience').get(function() {
  return this.statistics.level * 1000; // Mỗi level cần thêm 1000 exp
});

userSchema.virtual('experienceProgress').get(function() {
  const currentLevelExp = (this.statistics.level - 1) * 1000;
  const nextLevelExp = this.statistics.level * 1000;
  const progress = (this.statistics.experience - currentLevelExp) / (nextLevelExp - currentLevelExp);
  return Math.max(0, Math.min(1, progress));
});

// Pre-save middleware
userSchema.pre('save', async function(next) {
  // Hash password nếu đã được modify
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  
  // Tạo referral code nếu chưa có
  if (this.isNew && !this.referral.code) {
    this.referral.code = this.username.toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  
  // Update level dựa trên experience
  if (this.isModified('statistics.experience')) {
    const newLevel = Math.floor(this.statistics.experience / 1000) + 1;
    if (newLevel > this.statistics.level) {
      this.statistics.level = newLevel;
    }
  }
  
  next();
});

// Instance methods
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.addCoins = function(amount, type = 'game_reward') {
  this.coins.available += amount;
  this.coins.total += amount;
  return this.save();
};

userSchema.methods.deductCoins = function(amount, type = 'withdrawal') {
  if (this.coins.available < amount) {
    throw new Error('Insufficient coins');
  }
  this.coins.available -= amount;
  return this.save();
};

userSchema.methods.addExperience = function(exp) {
  this.statistics.experience += exp;
  return this.save();
};

userSchema.methods.updateStats = function(gameData) {
  this.statistics.totalGames += 1;
  this.statistics.totalScore += gameData.score;
  if (gameData.score > this.statistics.bestScore) {
    this.statistics.bestScore = gameData.score;
  }
  this.statistics.totalPlayTime += gameData.playTime;
  
  // Add experience based on score
  const expGained = Math.floor(gameData.score / 100);
  this.addExperience(expGained);
  
  return this.save();
};

userSchema.methods.canWithdraw = function(amount) {
  const minWithdrawal = parseFloat(process.env.MIN_WITHDRAWAL) || 10;
  return this.kyc.status === 'verified' && 
         this.coins.available >= amount && 
         amount >= minWithdrawal;
};

userSchema.methods.lockAccount = function(duration = 30) {
  this.security.accountLocked = true;
  this.security.lockedUntil = new Date(Date.now() + duration * 60 * 1000);
  return this.save();
};

userSchema.methods.unlockAccount = function() {
  this.security.accountLocked = false;
  this.security.lockedUntil = undefined;
  this.security.failedLoginAttempts = 0;
  return this.save();
};

// Static methods
userSchema.statics.findByCredentials = async function(email, password) {
  const user = await this.findOne({ email }).select('+password');
  
  if (!user) {
    throw new Error('Invalid credentials');
  }
  
  if (user.security.accountLocked && user.security.lockedUntil > new Date()) {
    throw new Error('Account is temporarily locked');
  }
  
  const isMatch = await user.comparePassword(password);
  
  if (!isMatch) {
    user.security.failedLoginAttempts += 1;
    
    if (user.security.failedLoginAttempts >= 5) {
      await user.lockAccount();
      throw new Error('Account locked due to multiple failed login attempts');
    }
    
    await user.save();
    throw new Error('Invalid credentials');
  }
  
  // Reset failed attempts on successful login
  if (user.security.failedLoginAttempts > 0) {
    user.security.failedLoginAttempts = 0;
    await user.save();
  }
  
  return user;
};

module.exports = mongoose.model('User', userSchema);