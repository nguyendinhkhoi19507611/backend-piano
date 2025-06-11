
const Game = require('../models/Game');
const User = require('../models/User');
const Music = require('../models/Music');
const Transaction = require('../models/Transaction');
const crypto = require('crypto');

class GameService {
  
  // Create new game session
  static async startGame(userId, musicId, settings = {}) {
    try {
      // Validate music exists and is available
      const music = await Music.findById(musicId);
      if (!music || music.status !== 'published') {
        throw new Error('Music not available');
      }

      // Check user permissions
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check premium requirements
      if (music.availability.premium && !user.subscriptions.premium.active) {
        throw new Error('Premium subscription required');
      }

      // Generate unique session ID
      const sessionId = crypto.randomUUID();

      // Create game session
      const game = new Game({
        userId,
        musicId,
        session: {
          sessionId,
          startTime: new Date(),
          status: 'active'
        },
        settings: {
          difficulty: settings.difficulty || 'easy',
          speed: settings.speed || 1.0,
          autoPlay: settings.autoPlay || false,
          soundEnabled: settings.soundEnabled !== false,
          visualEffects: settings.visualEffects !== false
        },
        scoring: {
          multiplier: this.calculateMultiplier(settings.difficulty, settings.speed)
        },
        metadata: {
          platform: settings.platform || 'web',
          clientIP: settings.clientIP,
          userAgent: settings.userAgent
        }
      });

      await game.save();

      // Increment music play count
      await music.incrementPlayCount();

      return {
        success: true,
        game: {
          id: game._id,
          sessionId: game.session.sessionId,
          music: {
            id: music._id,
            title: music.title,
            artist: music.artist,
            duration: music.duration,
            difficulty: music.difficulty,
            audio: music.audio,
            sheet: music.sheet
          },
          settings: game.settings
        }
      };

    } catch (error) {
      throw new Error(`Failed to start game: ${error.message}`);
    }
  }

  // Process keystroke input
  static async processKeystroke(sessionId, keystrokeData) {
    try {
      const { key, timestamp, accuracy, reactionTime } = keystrokeData;

      const game = await Game.findOne({ 'session.sessionId': sessionId });
      if (!game || game.session.status !== 'active') {
        throw new Error('Game session not found or not active');
      }

      // Add keystroke to game
      await game.addKeystroke(key, accuracy, reactionTime);

      // Calculate real-time rewards
      const points = game.calculateKeystrokePoints(accuracy, game.gameplay.currentCombo);
      
      return {
        success: true,
        points,
        combo: game.gameplay.currentCombo,
        totalScore: game.scoring.totalScore,
        accuracy: game.gameplay.accuracy
      };

    } catch (error) {
      throw new Error(`Failed to process keystroke: ${error.message}`);
    }
  }

  // End game session
  static async endGame(sessionId, endData = {}) {
    try {
      const game = await Game.findOne({ 'session.sessionId': sessionId })
        .populate('userId')
        .populate('musicId');

      if (!game) {
        throw new Error('Game session not found');
      }

      if (game.session.status !== 'active') {
        throw new Error('Game is not active');
      }

      // Complete the game
      await game.completeGame();

      // Update user statistics
      const gameData = {
        score: game.scoring.totalScore,
        accuracy: game.gameplay.accuracy,
        playTime: game.session.duration
      };

      await game.userId.updateStats(gameData);

      // Update music statistics
      await game.musicId.updateScore(game.scoring.totalScore, game.gameplay.accuracy);

      return {
        success: true,
        results: {
          score: game.scoring.totalScore,
          accuracy: game.gameplay.accuracy,
          combo: game.gameplay.maxCombo,
          duration: game.session.duration,
          rewards: game.rewards,
          achievements: game.achievements
        }
      };

    } catch (error) {
      throw new Error(`Failed to end game: ${error.message}`);
    }
  }

  // Claim game rewards
  static async claimRewards(sessionId, userId) {
    try {
      const game = await Game.findOne({ 
        'session.sessionId': sessionId,
        userId,
        'session.status': 'completed'
      });

      if (!game) {
        throw new Error('Game session not found or not completed');
      }

      if (game.rewards.claimed) {
        throw new Error('Rewards already claimed');
      }

      // Claim rewards from game
      const rewardData = await game.claimRewards();

      // Update user coins and experience
      const user = await User.findById(userId);
      await user.addCoins(rewardData.coins, 'game_reward');
      await user.addExperience(rewardData.experience);

      // Create transaction record
      await Transaction.createGameReward(
        userId, 
        game._id, 
        rewardData.coins,
        {
          score: game.scoring.totalScore,
          accuracy: game.gameplay.accuracy,
          playTime: game.session.duration
        }
      );

      return {
        success: true,
        rewards: rewardData,
        newBalance: user.coins.available,
        newLevel: user.statistics.level,
        experienceGained: rewardData.experience
      };

    } catch (error) {
      throw new Error(`Failed to claim rewards: ${error.message}`);
    }
  }

  // Pause game
  static async pauseGame(sessionId) {
    try {
      const game = await Game.findOne({ 'session.sessionId': sessionId });
      
      if (!game || game.session.status !== 'active') {
        throw new Error('Game session not found or not active');
      }

      await game.pauseGame();

      return {
        success: true,
        message: 'Game paused successfully'
      };

    } catch (error) {
      throw new Error(`Failed to pause game: ${error.message}`);
    }
  }

  // Resume game
  static async resumeGame(sessionId) {
    try {
      const game = await Game.findOne({ 'session.sessionId': sessionId });
      
      if (!game || game.session.status !== 'paused') {
        throw new Error('Game session not found or not paused');
      }

      await game.resumeGame();

      return {
        success: true,
        message: 'Game resumed successfully'
      };

    } catch (error) {
      throw new Error(`Failed to resume game: ${error.message}`);
    }
  }

  // Abandon game
  static async abandonGame(sessionId) {
    try {
      const game = await Game.findOne({ 'session.sessionId': sessionId });
      
      if (!game) {
        throw new Error('Game session not found');
      }

      await game.abandonGame();

      return {
        success: true,
        message: 'Game abandoned'
      };

    } catch (error) {
      throw new Error(`Failed to abandon game: ${error.message}`);
    }
  }

  // Get game session details
  static async getGameSession(sessionId, userId) {
    try {
      const game = await Game.findOne({ 
        'session.sessionId': sessionId,
        userId 
      })
      .populate('musicId')
      .populate('userId', 'username avatar statistics');

      if (!game) {
        throw new Error('Game session not found');
      }

      return {
        success: true,
        game: {
          id: game._id,
          sessionId: game.session.sessionId,
          status: game.session.status,
          startTime: game.session.startTime,
          duration: game.session.duration,
          music: game.musicId,
          player: game.userId,
          gameplay: game.gameplay,
          scoring: game.scoring,
          rewards: game.rewards,
          achievements: game.achievements,
          settings: game.settings
        }
      };

    } catch (error) {
      throw new Error(`Failed to get game session: ${error.message}`);
    }
  }

  // Get player statistics
  static async getPlayerStats(userId, period = '30d') {
    try {
      const stats = await Game.getPlayerStats(userId, period);
      const user = await User.findById(userId);

      return {
        success: true,
        stats: {
          ...stats,
          currentLevel: user.statistics.level,
          totalCoins: user.coins.total,
          availableCoins: user.coins.available,
          experienceProgress: user.experienceProgress,
          nextLevelExperience: user.nextLevelExperience
        },
        period
      };

    } catch (error) {
      throw new Error(`Failed to get player stats: ${error.message}`);
    }
  }

  // Get leaderboard
  static async getLeaderboard(period = '30d', limit = 100) {
    try {
      const leaderboard = await Game.getLeaderboard(period, limit);

      return {
        success: true,
        leaderboard,
        period,
        total: leaderboard.length
      };

    } catch (error) {
      throw new Error(`Failed to get leaderboard: ${error.message}`);
    }
  }

  // Calculate score multiplier based on difficulty and speed
  static calculateMultiplier(difficulty, speed) {
    const difficultyMultipliers = {
      'easy': 1.0,
      'medium': 1.2,
      'hard': 1.5,
      'expert': 2.0
    };

    const speedMultiplier = Math.max(0.5, Math.min(2.0, speed));
    
    return (difficultyMultipliers[difficulty] || 1.0) * speedMultiplier;
  }

  // Validate game settings
  static validateGameSettings(settings) {
    const errors = [];

    if (settings.difficulty && !['easy', 'medium', 'hard', 'expert'].includes(settings.difficulty)) {
      errors.push('Invalid difficulty level');
    }

    if (settings.speed && (settings.speed < 0.5 || settings.speed > 2.0)) {
      errors.push('Speed must be between 0.5 and 2.0');
    }

    if (typeof settings.autoPlay !== 'undefined' && typeof settings.autoPlay !== 'boolean') {
      errors.push('AutoPlay must be boolean');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  // Generate game analytics
  static async generateAnalytics(userId, gameId) {
    try {
      const game = await Game.findOne({ _id: gameId, userId })
        .populate('musicId');

      if (!game) {
        throw new Error('Game not found');
      }

      // Analyze performance patterns
      const analytics = {
        overall: {
          score: game.scoring.totalScore,
          accuracy: game.gameplay.accuracy,
          consistency: this.calculateConsistency(game.keystrokes),
          improvement: await this.calculateImprovement(userId, game.musicId._id)
        },
        timing: {
          averageReactionTime: game.gameplay.averageReactionTime,
          rushTendency: this.calculateRushTendency(game.keystrokes),
          lagTendency: this.calculateLagTendency(game.keystrokes)
        },
        patterns: {
          strongKeys: this.findStrongKeys(game.keystrokes),
          weakKeys: this.findWeakKeys(game.keystrokes),
          comboBreakers: this.findComboBreakers(game.keystrokes)
        },
        recommendations: this.generateRecommendations(game)
      };

      return {
        success: true,
        analytics
      };

    } catch (error) {
      throw new Error(`Failed to generate analytics: ${error.message}`);
    }
  }

  // Helper methods for analytics
  static calculateConsistency(keystrokes) {
    if (keystrokes.length === 0) return 0;
    
    const reactionTimes = keystrokes.map(k => k.reactionTime).filter(rt => rt > 0);
    const mean = reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length;
    const variance = reactionTimes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / reactionTimes.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Lower standard deviation = higher consistency
    return Math.max(0, 100 - (standardDeviation / mean * 100));
  }

  static async calculateImprovement(userId, musicId) {
    const recentGames = await Game.find({
      userId,
      musicId,
      'session.status': 'completed'
    })
    .sort({ createdAt: -1 })
    .limit(5);

    if (recentGames.length < 2) return 0;

    const latestScore = recentGames[0].scoring.totalScore;
    const previousAverage = recentGames.slice(1).reduce((sum, game) => 
      sum + game.scoring.totalScore, 0) / (recentGames.length - 1);

    return ((latestScore - previousAverage) / previousAverage) * 100;
  }

  static calculateRushTendency(keystrokes) {
    const earlyHits = keystrokes.filter(k => k.reactionTime < 100).length;
    return (earlyHits / keystrokes.length) * 100;
  }

  static calculateLagTendency(keystrokes) {
    const lateHits = keystrokes.filter(k => k.reactionTime > 300).length;
    return (lateHits / keystrokes.length) * 100;
  }

  static findStrongKeys(keystrokes) {
    const keyStats = {};
    
    keystrokes.forEach(k => {
      if (!keyStats[k.key]) {
        keyStats[k.key] = { total: 0, perfect: 0 };
      }
      keyStats[k.key].total++;
      if (k.accuracy === 'perfect') {
        keyStats[k.key].perfect++;
      }
    });

    return Object.entries(keyStats)
      .map(([key, stats]) => ({
        key,
        accuracy: (stats.perfect / stats.total) * 100,
        total: stats.total
      }))
      .filter(k => k.total >= 5 && k.accuracy >= 90)
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, 5);
  }

  static findWeakKeys(keystrokes) {
    const keyStats = {};
    
    keystrokes.forEach(k => {
      if (!keyStats[k.key]) {
        keyStats[k.key] = { total: 0, perfect: 0, miss: 0 };
      }
      keyStats[k.key].total++;
      if (k.accuracy === 'perfect') {
        keyStats[k.key].perfect++;
      } else if (k.accuracy === 'miss') {
        keyStats[k.key].miss++;
      }
    });

    return Object.entries(keyStats)
      .map(([key, stats]) => ({
        key,
        accuracy: (stats.perfect / stats.total) * 100,
        missRate: (stats.miss / stats.total) * 100,
        total: stats.total
      }))
      .filter(k => k.total >= 5 && k.accuracy < 70)
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 5);
  }

  static findComboBreakers(keystrokes) {
    const comboBreakers = [];
    let currentCombo = 0;
    
    keystrokes.forEach((k, index) => {
      if (k.accuracy === 'perfect' || k.accuracy === 'good') {
        currentCombo++;
      } else {
        if (currentCombo >= 10) {
          comboBreakers.push({
            key: k.key,
            comboLost: currentCombo,
            timestamp: k.timestamp
          });
        }
        currentCombo = 0;
      }
    });

    return comboBreakers.sort((a, b) => b.comboLost - a.comboLost).slice(0, 5);
  }

  static generateRecommendations(game) {
    const recommendations = [];

    // Accuracy recommendations
    if (game.gameplay.accuracy < 80) {
      recommendations.push({
        type: 'accuracy',
        message: 'Focus on accuracy over speed. Try slowing down the game speed.',
        priority: 'high'
      });
    }

    // Speed recommendations
    if (game.gameplay.averageReactionTime > 300) {
      recommendations.push({
        type: 'speed',
        message: 'Practice finger exercises to improve reaction time.',
        priority: 'medium'
      });
    }

    // Consistency recommendations
    if (game.gameplay.maxCombo < game.gameplay.totalNotes * 0.3) {
      recommendations.push({
        type: 'consistency',
        message: 'Work on maintaining combos. Practice the same song multiple times.',
        priority: 'medium'
      });
    }

    // Difficulty recommendations
    if (game.gameplay.accuracy > 95 && game.settings.difficulty === 'easy') {
      recommendations.push({
        type: 'difficulty',
        message: 'You\'re ready for a higher difficulty level!',
        priority: 'low'
      });
    }

    return recommendations;
  }

  // Validate active game session
  static async validateSession(sessionId, userId) {
    try {
      const game = await Game.findOne({
        'session.sessionId': sessionId,
        userId,
        'session.status': { $in: ['active', 'paused'] }
      });

      return !!game;
    } catch (error) {
      return false;
    }
  }

  // Clean up expired game sessions
  static async cleanupExpiredSessions() {
    try {
      const expiredTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      
      const result = await Game.updateMany(
        {
          'session.status': 'active',
          'session.startTime': { $lt: expiredTime }
        },
        {
          'session.status': 'abandoned',
          'session.endTime': new Date()
        }
      );

      console.log(`Cleaned up ${result.modifiedCount} expired game sessions`);
      return result.modifiedCount;

    } catch (error) {
      console.error('Error cleaning up expired sessions:', error);
      return 0;
    }
  }
}

module.exports = GameService;