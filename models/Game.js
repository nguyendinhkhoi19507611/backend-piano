
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  musicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Music',
    required: true
  },
  session: {
    sessionId: {
      type: String,
      required: true,
      unique: true
    },
    startTime: {
      type: Date,
      default: Date.now
    },
    endTime: Date,
    duration: {
      type: Number, // Tính bằng giây
      default: 0
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'abandoned', 'paused'],
      default: 'active'
    }
  },
  gameplay: {
    totalNotes: {
      type: Number,
      default: 0
    },
    correctNotes: {
      type: Number,
      default: 0
    },
    missedNotes: {
      type: Number,
      default: 0
    },
    accuracy: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    maxCombo: {
      type: Number,
      default: 0
    },
    currentCombo: {
      type: Number,
      default: 0
    },
    perfectHits: {
      type: Number,
      default: 0
    },
    goodHits: {
      type: Number,
      default: 0
    },
    averageReactionTime: {
      type: Number,
      default: 0 // Tính bằng milliseconds
    }
  },
  scoring: {
    baseScore: {
      type: Number,
      default: 0
    },
    comboBonus: {
      type: Number,
      default: 0
    },
    accuracyBonus: {
      type: Number,
      default: 0
    },
    speedBonus: {
      type: Number,
      default: 0
    },
    totalScore: {
      type: Number,
      default: 0
    },
    multiplier: {
      type: Number,
      default: 1.0,
      min: 1.0,
      max: 5.0
    }
  },
  rewards: {
    points: {
      type: Number,
      default: 0
    },
    coins: {
      type: Number,
      default: 0
    },
    experience: {
      type: Number,
      default: 0
    },
    bonusCoins: {
      type: Number,
      default: 0
    },
    claimed: {
      type: Boolean,
      default: false
    },
    claimedAt: Date
  },
  keystrokes: [{
    key: {
      type: String,
      required: true
    },
    timestamp: {
      type: Number,
      required: true
    },
    accuracy: {
      type: String,
      enum: ['perfect', 'good', 'miss'],
      required: true
    },
    reactionTime: {
      type: Number // Milliseconds
    },
    points: {
      type: Number,
      default: 0
    }
  }],
  powerUps: [{
    type: {
      type: String,
      enum: ['double_score', 'time_slow', 'auto_play', 'shield', 'coin_boost']
    },
    activatedAt: {
      type: Number // Game timestamp
    },
    duration: {
      type: Number // Seconds
    },
    effect: mongoose.Schema.Types.Mixed
  }],
  settings: {
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard', 'expert'],
      default: 'easy'
    },
    speed: {
      type: Number,
      default: 1.0,
      min: 0.5,
      max: 2.0
    },
    autoPlay: {
      type: Boolean,
      default: false
    },
    soundEnabled: {
      type: Boolean,
      default: true
    },
    visualEffects: {
      type: Boolean,
      default: true
    }
  },
  achievements: [{
    type: {
      type: String,
      enum: ['first_game', 'perfect_combo', 'speed_demon', 'accuracy_master', 'endurance_player']
    },
    unlockedAt: {
      type: Date,
      default: Date.now
    },
    description: String,
    reward: {
      coins: Number,
      experience: Number
    }
  }],
  analytics: {
    deviceInfo: {
      platform: String,
      browser: String,
      screenSize: String,
      touchSupport: Boolean
    },
    networkInfo: {
      latency: Number,
      connectionType: String,
      bandwidth: Number
    },
    performanceMetrics: {
      avgFPS: Number,
      memoryUsage: Number,
      loadTime: Number,
      lagSpikes: Number
    }
  },
  metadata: {
    version: {
      type: String,
      default: '1.0.0'
    },
    platform: {
      type: String,
      enum: ['web', 'mobile', 'desktop'],
      default: 'web'
    },
    clientIP: String,
    userAgent: String,
    referrer: String
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtuals
gameSchema.virtual('accuracyPercentage').get(function() {
  if (this.gameplay.totalNotes === 0) return 0;
  return (this.gameplay.correctNotes / this.gameplay.totalNotes) * 100;
});

gameSchema.virtual('missRate').get(function() {
  if (this.gameplay.totalNotes === 0) return 0;
  return (this.gameplay.missedNotes / this.gameplay.totalNotes) * 100;
});

gameSchema.virtual('notesPerSecond').get(function() {
  if (this.session.duration === 0) return 0;
  return this.gameplay.totalNotes / this.session.duration;
});

gameSchema.virtual('isActive').get(function() {
  return this.session.status === 'active';
});

gameSchema.virtual('isCompleted').get(function() {
  return this.session.status === 'completed';
});

// Indexes for better performance
gameSchema.index({ userId: 1, createdAt: -1 });
gameSchema.index({ 'session.status': 1 });
gameSchema.index({ 'scoring.totalScore': -1 });
gameSchema.index({ 'session.sessionId': 1 }, { unique: true });

// Pre-save middleware
gameSchema.pre('save', function(next) {
  // Calculate accuracy
  if (this.gameplay.totalNotes > 0) {
    this.gameplay.accuracy = (this.gameplay.correctNotes / this.gameplay.totalNotes) * 100;
  }
  
  // Calculate total score
  this.scoring.totalScore = this.scoring.baseScore + 
                           this.scoring.comboBonus + 
                           this.scoring.accuracyBonus + 
                           this.scoring.speedBonus;
  
  // Calculate rewards
  if (this.isModified('scoring.totalScore')) {
    this.rewards.points = Math.floor(this.scoring.totalScore);
    this.rewards.coins = Math.floor(this.scoring.totalScore * (parseFloat(process.env.COIN_PER_POINT) || 0.001));
    this.rewards.experience = Math.floor(this.scoring.totalScore / 100);
  }
  
  // Calculate session duration
  if (this.session.endTime && this.session.startTime) {
    this.session.duration = Math.floor((this.session.endTime - this.session.startTime) / 1000);
  }
  
  next();
});

// Instance methods
gameSchema.methods.addKeystroke = function(key, accuracy, reactionTime) {
  const points = this.calculateKeystrokePoints(accuracy, this.gameplay.currentCombo);
  
  this.keystrokes.push({
    key,
    timestamp: Date.now() - this.session.startTime.getTime(),
    accuracy,
    reactionTime,
    points
  });
  
  this.gameplay.totalNotes += 1;
  
  if (accuracy === 'perfect') {
    this.gameplay.perfectHits += 1;
    this.gameplay.correctNotes += 1;
    this.gameplay.currentCombo += 1;
    this.gameplay.maxCombo = Math.max(this.gameplay.maxCombo, this.gameplay.currentCombo);
  } else if (accuracy === 'good') {
    this.gameplay.goodHits += 1;
    this.gameplay.correctNotes += 1;
    this.gameplay.currentCombo += 1;
    this.gameplay.maxCombo = Math.max(this.gameplay.maxCombo, this.gameplay.currentCombo);
  } else {
    this.gameplay.missedNotes += 1;
    this.gameplay.currentCombo = 0;
  }
  
  this.scoring.baseScore += points;
  this.updateBonusScores();
  
  return this.save();
};

gameSchema.methods.calculateKeystrokePoints = function(accuracy, combo) {
  let basePoints = 0;
  
  switch (accuracy) {
    case 'perfect':
      basePoints = 100;
      break;
    case 'good':
      basePoints = 70;
      break;
    case 'miss':
      basePoints = 0;
      break;
  }
  
  // Combo multiplier
  const comboMultiplier = Math.min(1 + (combo * 0.1), 3);
  
  return Math.floor(basePoints * comboMultiplier * this.scoring.multiplier);
};

gameSchema.methods.updateBonusScores = function() {
  // Combo bonus
  this.scoring.comboBonus = Math.floor(this.gameplay.maxCombo * 50);
  
  // Accuracy bonus
  if (this.gameplay.accuracy >= 95) {
    this.scoring.accuracyBonus = Math.floor(this.scoring.baseScore * 0.5);
  } else if (this.gameplay.accuracy >= 90) {
    this.scoring.accuracyBonus = Math.floor(this.scoring.baseScore * 0.3);
  } else if (this.gameplay.accuracy >= 80) {
    this.scoring.accuracyBonus = Math.floor(this.scoring.baseScore * 0.1);
  }
  
  // Speed bonus
  if (this.notesPerSecond > 5) {
    this.scoring.speedBonus = Math.floor(this.scoring.baseScore * 0.2);
  } else if (this.notesPerSecond > 3) {
    this.scoring.speedBonus = Math.floor(this.scoring.baseScore * 0.1);
  }
};

gameSchema.methods.completeGame = function() {
  this.session.status = 'completed';
  this.session.endTime = new Date();
  
  // Check for achievements
  this.checkAchievements();
  
  return this.save();
};

gameSchema.methods.checkAchievements = function() {
  // First game achievement
  if (this.gameplay.totalNotes > 0 && !this.achievements.find(a => a.type === 'first_game')) {
    this.achievements.push({
      type: 'first_game',
      description: 'Completed your first game!',
      reward: { coins: 50, experience: 100 }
    });
  }
  
  // Perfect combo achievement
  if (this.gameplay.maxCombo >= 100 && !this.achievements.find(a => a.type === 'perfect_combo')) {
    this.achievements.push({
      type: 'perfect_combo',
      description: 'Achieved a combo of 100+!',
      reward: { coins: 200, experience: 300 }
    });
  }
  
  // Accuracy master achievement
  if (this.gameplay.accuracy >= 98 && !this.achievements.find(a => a.type === 'accuracy_master')) {
    this.achievements.push({
      type: 'accuracy_master',
      description: 'Achieved 98%+ accuracy!',
      reward: { coins: 150, experience: 250 }
    });
  }
  
  // Speed demon achievement
  if (this.notesPerSecond >= 6 && !this.achievements.find(a => a.type === 'speed_demon')) {
    this.achievements.push({
      type: 'speed_demon',
      description: 'Played at lightning speed!',
      reward: { coins: 100, experience: 200 }
    });
  }
  
  // Endurance player achievement
  if (this.session.duration >= 300 && !this.achievements.find(a => a.type === 'endurance_player')) {
    this.achievements.push({
      type: 'endurance_player',
      description: 'Played for 5+ minutes straight!',
      reward: { coins: 75, experience: 150 }
    });
  }
};

gameSchema.methods.claimRewards = async function() {
  if (this.rewards.claimed) {
    throw new Error('Rewards already claimed');
  }
  
  let totalCoins = this.rewards.coins + this.rewards.bonusCoins;
  let totalExperience = this.rewards.experience;
  
  // Add achievement rewards
  this.achievements.forEach(achievement => {
    if (achievement.reward) {
      totalCoins += achievement.reward.coins || 0;
      totalExperience += achievement.reward.experience || 0;
    }
  });
  
  this.rewards.claimed = true;
  this.rewards.claimedAt = new Date();
  
  await this.save();
  
  return {
    coins: totalCoins,
    experience: totalExperience,
    achievements: this.achievements
  };
};

gameSchema.methods.pauseGame = function() {
  this.session.status = 'paused';
  return this.save();
};

gameSchema.methods.resumeGame = function() {
  this.session.status = 'active';
  return this.save();
};

gameSchema.methods.abandonGame = function() {
  this.session.status = 'abandoned';
  this.session.endTime = new Date();
  return this.save();
};

// Static methods
gameSchema.statics.getPlayerStats = async function(userId, period = '30d') {
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
  
  const stats = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        'session.status': 'completed',
        createdAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: null,
        totalGames: { $sum: 1 },
        totalScore: { $sum: '$scoring.totalScore' },
        averageScore: { $avg: '$scoring.totalScore' },
        bestScore: { $max: '$scoring.totalScore' },
        totalPlayTime: { $sum: '$session.duration' },
        averageAccuracy: { $avg: '$gameplay.accuracy' },
        totalNotes: { $sum: '$gameplay.totalNotes' },
        totalCoinsEarned: { $sum: '$rewards.coins' },
        bestCombo: { $max: '$gameplay.maxCombo' }
      }
    }
  ]);
  
  return stats[0] || {
    totalGames: 0,
    totalScore: 0,
    averageScore: 0,
    bestScore: 0,
    totalPlayTime: 0,
    averageAccuracy: 0,
    totalNotes: 0,
    totalCoinsEarned: 0,
    bestCombo: 0
  };
};

gameSchema.statics.getLeaderboard = async function(period = '30d', limit = 100) {
  const startDate = new Date();
  
  switch (period) {
    case '7d':
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(startDate.getDate() - 30);
      break;
    case 'all':
      startDate.setFullYear(2000);
      break;
  }
  
  return await this.aggregate([
    {
      $match: {
        'session.status': 'completed',
        createdAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$userId',
        bestScore: { $max: '$scoring.totalScore' },
        totalGames: { $sum: 1 },
        averageScore: { $avg: '$scoring.totalScore' },
        totalCoins: { $sum: '$rewards.coins' }
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user'
      }
    },
    {
      $unwind: '$user'
    },
    {
      $project: {
        userId: '$_id',
        username: '$user.username',
        avatar: '$user.avatar',
        bestScore: 1,
        totalGames: 1,
        averageScore: 1,
        totalCoins: 1
      }
    },
    {
      $sort: { bestScore: -1 }
    },
    {
      $limit: limit
    }
  ]);
};

module.exports = mongoose.model('Game', gameSchema);