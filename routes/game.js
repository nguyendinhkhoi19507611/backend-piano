// routes/game.js - Game session and gameplay routes
const express = require('express');
const { authenticateToken, userRateLimit, requireOwnership } = require('../middleware/auth');
const GameService = require('../services/gameService');
const Game = require('../models/Game');
const Music = require('../models/Music');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiting for game actions
const gameActionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 actions per minute
  message: {
    success: false,
    message: 'Too many game actions, please slow down.'
  }
});

// @route   POST /api/game/start
// @desc    Start new game session
// @access  Private
router.post('/start', authenticateToken, userRateLimit, async (req, res) => {
  try {
    const { musicId, settings = {} } = req.body;

    if (!musicId) {
      return res.status(400).json({
        success: false,
        message: 'Music ID is required'
      });
    }

    // Validate settings
    const validation = GameService.validateGameSettings(settings);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid game settings',
        errors: validation.errors
      });
    }

    // Add client info to settings
    settings.clientIP = req.ip;
    settings.userAgent = req.get('User-Agent');
    settings.platform = req.body.platform || 'web';

    const result = await GameService.startGame(req.user._id, musicId, settings);

    res.json(result);

  } catch (error) {
    console.error('Start game error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/game/:sessionId/keystroke
// @desc    Process keystroke input
// @access  Private
router.post('/:sessionId/keystroke', authenticateToken, gameActionLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { key, timestamp, accuracy, reactionTime } = req.body;

    // Validate input
    if (!key || !timestamp || !accuracy) {
      return res.status(400).json({
        success: false,
        message: 'Key, timestamp, and accuracy are required'
      });
    }

    if (!['perfect', 'good', 'miss'].includes(accuracy)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid accuracy value'
      });
    }

    // Validate session belongs to user
    const isValid = await GameService.validateSession(sessionId, req.user._id);
    if (!isValid) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired game session'
      });
    }

    const keystrokeData = {
      key,
      timestamp,
      accuracy,
      reactionTime: reactionTime || 0
    };

    const result = await GameService.processKeystroke(sessionId, keystrokeData);

    res.json(result);

  } catch (error) {
    console.error('Process keystroke error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/game/:sessionId/end
// @desc    End game session
// @access  Private
router.post('/:sessionId/end', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const endData = req.body;

    // Validate session belongs to user
    const isValid = await GameService.validateSession(sessionId, req.user._id);
    if (!isValid) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired game session'
      });
    }

    const result = await GameService.endGame(sessionId, endData);

    res.json(result);

  } catch (error) {
    console.error('End game error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/game/:sessionId/claim-rewards
// @desc    Claim game rewards
// @access  Private
router.post('/:sessionId/claim-rewards', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await GameService.claimRewards(sessionId, req.user._id);

    res.json(result);

  } catch (error) {
    console.error('Claim rewards error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/game/:sessionId/pause
// @desc    Pause game session
// @access  Private
router.post('/:sessionId/pause', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Validate session belongs to user
    const isValid = await GameService.validateSession(sessionId, req.user._id);
    if (!isValid) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired game session'
      });
    }

    const result = await GameService.pauseGame(sessionId);

    res.json(result);

  } catch (error) {
    console.error('Pause game error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/game/:sessionId/resume
// @desc    Resume game session
// @access  Private
router.post('/:sessionId/resume', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await GameService.resumeGame(sessionId);

    res.json(result);

  } catch (error) {
    console.error('Resume game error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   POST /api/game/:sessionId/abandon
// @desc    Abandon game session
// @access  Private
router.post('/:sessionId/abandon', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await GameService.abandonGame(sessionId);

    res.json(result);

  } catch (error) {
    console.error('Abandon game error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/game/:sessionId
// @desc    Get game session details
// @access  Private
router.get('/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await GameService.getGameSession(sessionId, req.user._id);

    res.json(result);

  } catch (error) {
    console.error('Get game session error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/game/stats/player
// @desc    Get player statistics
// @access  Private
router.get('/stats/player', authenticateToken, async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    const result = await GameService.getPlayerStats(req.user._id, period);

    res.json(result);

  } catch (error) {
    console.error('Get player stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/game/leaderboard
// @desc    Get leaderboard
// @access  Public
router.get('/leaderboard', async (req, res) => {
  try {
    const { period = '30d', limit = 100 } = req.query;

    const result = await GameService.getLeaderboard(period, parseInt(limit));

    res.json(result);

  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/game/history
// @desc    Get user's game history
// @access  Private
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, musicId } = req.query;
    
    const filter = { userId: req.user._id };
    if (status) filter['session.status'] = status;
    if (musicId) filter.musicId = musicId;

    const games = await Game.find(filter)
      .populate('musicId', 'title artist duration difficulty')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Game.countDocuments(filter);

    res.json({
      success: true,
      games,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get game history error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving game history'
    });
  }
});

// @route   GET /api/game/:gameId/analytics
// @desc    Get game analytics
// @access  Private
router.get('/:gameId/analytics', authenticateToken, requireOwnership(Game, 'gameId'), async (req, res) => {
  try {
    const { gameId } = req.params;

    const result = await GameService.generateAnalytics(req.user._id, gameId);

    res.json(result);

  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// @route   GET /api/game/achievements
// @desc    Get user achievements
// @access  Private
router.get('/achievements', authenticateToken, async (req, res) => {
  try {
    const games = await Game.find({ userId: req.user._id })
      .select('achievements createdAt')
      .sort({ createdAt: -1 });

    // Collect all achievements
    const allAchievements = [];
    games.forEach(game => {
      game.achievements.forEach(achievement => {
        allAchievements.push({
          ...achievement.toObject(),
          gameId: game._id,
          earnedAt: achievement.unlockedAt || game.createdAt
        });
      });
    });

    // Sort by date and remove duplicates
    const uniqueAchievements = allAchievements
      .sort((a, b) => b.earnedAt - a.earnedAt)
      .filter((achievement, index, array) => 
        array.findIndex(a => a.type === achievement.type) === index
      );

    // Achievement statistics
    const achievementStats = {
      total: uniqueAchievements.length,
      totalPossible: 5, // Based on achievement types in Game model
      completionRate: (uniqueAchievements.length / 5) * 100,
      latestUnlocked: uniqueAchievements[0] || null
    };

    res.json({
      success: true,
      achievements: uniqueAchievements,
      stats: achievementStats
    });

  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving achievements'
    });
  }
});

// @route   GET /api/game/recent
// @desc    Get recent games
// @access  Private
router.get('/recent', authenticateToken, async (req, res) => {
  try {
    const recentGames = await Game.find({ 
      userId: req.user._id,
      'session.status': 'completed'
    })
    .populate('musicId', 'title artist duration difficulty genre')
    .sort({ createdAt: -1 })
    .limit(10);

    res.json({
      success: true,
      games: recentGames
    });

  } catch (error) {
    console.error('Get recent games error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving recent games'
    });
  }
});

// @route   GET /api/game/performance-trends
// @desc    Get performance trends
// @access  Private
router.get('/performance-trends', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const trends = await Game.aggregate([
      {
        $match: {
          userId: req.user._id,
          'session.status': 'completed',
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          avgScore: { $avg: '$scoring.totalScore' },
          avgAccuracy: { $avg: '$gameplay.accuracy' },
          gamesPlayed: { $sum: 1 },
          totalPlayTime: { $sum: '$session.duration' }
        }
      },
      {
        $sort: { '_id': 1 }
      }
    ]);

    res.json({
      success: true,
      trends,
      period: `${days} days`
    });

  } catch (error) {
    console.error('Get performance trends error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving performance trends'
    });
  }
});

// @route   POST /api/game/validate-session
// @desc    Validate game session (for reconnection)
// @access  Private
router.post('/validate-session', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Session ID is required'
      });
    }

    const isValid = await GameService.validateSession(sessionId, req.user._id);

    if (isValid) {
      const result = await GameService.getGameSession(sessionId, req.user._id);
      res.json({
        success: true,
        valid: true,
        session: result.game
      });
    } else {
      res.json({
        success: true,
        valid: false,
        message: 'Session not found or expired'
      });
    }

  } catch (error) {
    console.error('Validate session error:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating session'
    });
  }
});

// @route   GET /api/game/favorites
// @desc    Get user's favorite songs (most played)
// @access  Private
router.get('/favorites', authenticateToken, async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const favorites = await Game.aggregate([
      {
        $match: {
          userId: req.user._id,
          'session.status': 'completed'
        }
      },
      {
        $group: {
          _id: '$musicId',
          playCount: { $sum: 1 },
          avgScore: { $avg: '$scoring.totalScore' },
          bestScore: { $max: '$scoring.totalScore' },
          totalPlayTime: { $sum: '$session.duration' },
          lastPlayed: { $max: '$createdAt' }
        }
      },
      {
        $lookup: {
          from: 'music',
          localField: '_id',
          foreignField: '_id',
          as: 'music'
        }
      },
      {
        $unwind: '$music'
      },
      {
        $project: {
          music: 1,
          playCount: 1,
          avgScore: 1,
          bestScore: 1,
          totalPlayTime: 1,
          lastPlayed: 1
        }
      },
      {
        $sort: { playCount: -1, lastPlayed: -1 }
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    res.json({
      success: true,
      favorites
    });

  } catch (error) {
    console.error('Get favorites error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving favorite songs'
    });
  }
});

module.exports = router;