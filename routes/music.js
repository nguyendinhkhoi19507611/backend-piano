// routes/music.js - Music library and search routes
const express = require('express');
const { authenticateToken, optionalAuth, requirePremium } = require('../middleware/auth');
const Music = require('../models/Music');
const User = require('../models/User');

const router = express.Router();

// @route   GET /api/music/search
// @desc    Search music library
// @access  Public
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { 
      q, 
      genre, 
      difficulty, 
      page = 1, 
      limit = 20,
      sort = 'popularity' 
    } = req.query;

    // Build search filters
    const filters = { status: 'published' };
    
    if (genre) filters.genre = genre;
    if (difficulty) filters['difficulty.level'] = difficulty;
    
    // If user not premium, exclude premium songs
    if (!req.user || !req.user.subscriptions.premium.active) {
      filters['availability.premium'] = false;
    }

    // Search query
    let searchResults;
    if (q) {
      searchResults = await Music.search(q, filters);
    } else {
      let sortQuery = {};
      switch (sort) {
        case 'popularity':
          sortQuery = { 'statistics.playCount': -1 };
          break;
        case 'newest':
          sortQuery = { createdAt: -1 };
          break;
        case 'difficulty':
          sortQuery = { 'difficulty.rating': 1 };
          break;
        case 'duration':
          sortQuery = { duration: 1 };
          break;
        default:
          sortQuery = { 'statistics.playCount': -1 };
      }

      searchResults = await Music.find(filters)
        .sort(sortQuery)
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit));
    }

    const total = await Music.countDocuments(filters);

    res.json({
      success: true,
      music: searchResults,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      filters: {
        query: q,
        genre,
        difficulty,
        sort
      }
    });

  } catch (error) {
    console.error('Music search error:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching music library'
    });
  }
});

// @route   GET /api/music/:id
// @desc    Get music details
// @access  Public
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const music = await Music.findById(id);
    
    if (!music || music.status !== 'published') {
      return res.status(404).json({
        success: false,
        message: 'Music not found'
      });
    }

    // Check premium access
    if (music.availability.premium && (!req.user || !req.user.subscriptions.premium.active)) {
      return res.status(403).json({
        success: false,
        message: 'Premium subscription required',
        premium: true
      });
    }

    // Get user's best score for this music
    let userBestScore = null;
    if (req.user) {
      const Game = require('../models/Game');
      const bestGame = await Game.findOne({
        userId: req.user._id,
        musicId: id,
        'session.status': 'completed'
      }).sort({ 'scoring.totalScore': -1 });
      
      if (bestGame) {
        userBestScore = {
          score: bestGame.scoring.totalScore,
          accuracy: bestGame.gameplay.accuracy,
          achievedAt: bestGame.createdAt
        };
      }
    }

    res.json({
      success: true,
      music: {
        ...music.toObject(),
        userBestScore
      }
    });

  } catch (error) {
    console.error('Get music error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving music details'
    });
  }
});

// @route   GET /api/music/:id/preview
// @desc    Get music preview (30 seconds)
// @access  Public
router.get('/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;
    const { duration = 30 } = req.query;

    const music = await Music.findById(id);
    
    if (!music || music.status !== 'published') {
      return res.status(404).json({
        success: false,
        message: 'Music not found'
      });
    }

    const preview = music.generatePreview(parseInt(duration));

    res.json({
      success: true,
      preview: {
        ...preview,
        audio: music.audio,
        title: music.title,
        artist: music.artist
      }
    });

  } catch (error) {
    console.error('Get preview error:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating preview'
    });
  }
});

// @route   GET /api/music/trending
// @desc    Get trending music
// @access  Public
router.get('/trending', optionalAuth, async (req, res) => {
  try {
    const { period = '7d', limit = 20 } = req.query;

    const trending = await Music.getTrending(period, parseInt(limit));

    // Filter out premium songs for non-premium users
    const filteredTrending = trending.filter(item => {
      if (item.music.availability.premium) {
        return req.user && req.user.subscriptions.premium.active;
      }
      return true;
    });

    res.json({
      success: true,
      trending: filteredTrending,
      period
    });

  } catch (error) {
    console.error('Get trending error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving trending music'
    });
  }
});

// @route   GET /api/music/recommendations
// @desc    Get personalized music recommendations
// @access  Private
router.get('/recommendations', authenticateToken, async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const recommendations = await Music.getRecommendations(req.user._id, parseInt(limit));

    res.json({
      success: true,
      recommendations
    });

  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating recommendations'
    });
  }
});

// @route   GET /api/music/genres
// @desc    Get available genres
// @access  Public
router.get('/genres', async (req, res) => {
  try {
    const genres = await Music.distinct('genre', { status: 'published' });

    // Get count for each genre
    const genreStats = await Music.aggregate([
      {
        $match: { status: 'published' }
      },
      {
        $group: {
          _id: '$genre',
          count: { $sum: 1 },
          avgDifficulty: { $avg: '$difficulty.rating' },
          avgDuration: { $avg: '$duration' }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    res.json({
      success: true,
      genres: genreStats.map(g => ({
        name: g._id,
        count: g.count,
        avgDifficulty: Math.round(g.avgDifficulty * 10) / 10,
        avgDuration: Math.round(g.avgDuration)
      }))
    });

  } catch (error) {
    console.error('Get genres error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving genres'
    });
  }
});

// @route   POST /api/music/:id/like
// @desc    Like/unlike music
// @access  Private
router.post('/:id/like', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const music = await Music.findById(id);
    if (!music) {
      return res.status(404).json({
        success: false,
        message: 'Music not found'
      });
    }

    const user = await User.findById(req.user._id);
    const likedMusic = user.preferences.likedMusic || [];
    const isLiked = likedMusic.includes(id);

    if (isLiked) {
      // Unlike
      user.preferences.likedMusic = likedMusic.filter(musicId => musicId.toString() !== id);
      await music.removeLike();
    } else {
      // Like
      if (!user.preferences.likedMusic) user.preferences.likedMusic = [];
      user.preferences.likedMusic.push(id);
      await music.addLike();
    }

    await user.save();

    res.json({
      success: true,
      liked: !isLiked,
      likeCount: music.statistics.likeCount
    });

  } catch (error) {
    console.error('Like music error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating like status'
    });
  }
});

// @route   GET /api/music/liked
// @desc    Get user's liked music
// @access  Private
router.get('/liked', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(req.user._id);
    const likedMusicIds = user.preferences.likedMusic || [];

    if (likedMusicIds.length === 0) {
      return res.json({
        success: true,
        music: [],
        pagination: {
          page: 1,
          limit: parseInt(limit),
          total: 0,
          pages: 0
        }
      });
    }

    const likedMusic = await Music.find({
      _id: { $in: likedMusicIds },
      status: 'published'
    })
    .sort({ 'statistics.playCount': -1 })
    .limit(parseInt(limit))
    .skip((parseInt(page) - 1) * parseInt(limit));

    res.json({
      success: true,
      music: likedMusic,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: likedMusicIds.length,
        pages: Math.ceil(likedMusicIds.length / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get liked music error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving liked music'
    });
  }
});

// @route   POST /api/music/:id/report
// @desc    Report music issue
// @access  Private
router.post('/:id/report', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, description } = req.body;

    if (!type || !description) {
      return res.status(400).json({
        success: false,
        message: 'Issue type and description are required'
      });
    }

    const validTypes = ['audio_quality', 'sync_issue', 'wrong_notes', 'copyright', 'inappropriate'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid issue type'
      });
    }

    const music = await Music.findById(id);
    if (!music) {
      return res.status(404).json({
        success: false,
        message: 'Music not found'
      });
    }

    await music.reportIssue(type, description, req.user._id);

    res.json({
      success: true,
      message: 'Issue reported successfully'
    });

  } catch (error) {
    console.error('Report music error:', error);
    res.status(500).json({
      success: false,
      message: 'Error reporting issue'
    });
  }
});

// @route   GET /api/music/featured
// @desc    Get featured music
// @access  Public
router.get('/featured', optionalAuth, async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Get featured music (high quality, popular songs)
    const featured = await Music.find({
      status: 'published',
      'quality.verified': true,
      'statistics.playCount': { $gte: 100 },
      'statistics.averageScore': { $gte: 5000 }
    })
    .sort({ 'statistics.playCount': -1, 'statistics.averageScore': -1 })
    .limit(parseInt(limit));

    // Filter premium content for non-premium users
    const filteredFeatured = featured.filter(music => {
      if (music.availability.premium) {
        return req.user && req.user.subscriptions.premium.active;
      }
      return true;
    });

    res.json({
      success: true,
      featured: filteredFeatured
    });

  } catch (error) {
    console.error('Get featured error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving featured music'
    });
  }
});

// @route   GET /api/music/by-difficulty/:level
// @desc    Get music by difficulty level
// @access  Public
router.get('/by-difficulty/:level', optionalAuth, async (req, res) => {
  try {
    const { level } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const validLevels = ['easy', 'medium', 'hard', 'expert'];
    if (!validLevels.includes(level)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid difficulty level'
      });
    }

    const filters = {
      status: 'published',
      'difficulty.level': level
    };

    // Filter premium content for non-premium users
    if (!req.user || !req.user.subscriptions.premium.active) {
      filters['availability.premium'] = false;
    }

    const music = await Music.find(filters)
      .sort({ 'statistics.playCount': -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Music.countDocuments(filters);

    res.json({
      success: true,
      music,
      difficulty: level,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get music by difficulty error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving music by difficulty'
    });
  }
});

// @route   GET /api/music/new-releases
// @desc    Get new music releases
// @access  Public
router.get('/new-releases', optionalAuth, async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const filters = {
      status: 'published',
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
    };

    // Filter premium content for non-premium users
    if (!req.user || !req.user.subscriptions.premium.active) {
      filters['availability.premium'] = false;
    }

    const newReleases = await Music.find(filters)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      newReleases
    });

  } catch (error) {
    console.error('Get new releases error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving new releases'
    });
  }
});

// @route   GET /api/music/charts/top
// @desc    Get top charts
// @access  Public
router.get('/charts/top', optionalAuth, async (req, res) => {
  try {
    const { period = '7d', limit = 50 } = req.query;

    let dateFilter = {};
    const now = new Date();
    
    switch (period) {
      case '24h':
        dateFilter = { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) };
        break;
      case '7d':
        dateFilter = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
        break;
      case '30d':
        dateFilter = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
        break;
      case 'all':
        dateFilter = {};
        break;
    }

    const Game = require('../models/Game');
    
    // Get top played songs in the period
    const topCharts = await Game.aggregate([
      {
        $match: {
          'session.status': 'completed',
          ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter })
        }
      },
      {
        $group: {
          _id: '$musicId',
          playCount: { $sum: 1 },
          avgScore: { $avg: '$scoring.totalScore' },
          uniquePlayers: { $addToSet: '$userId' }
        }
      },
      {
        $addFields: {
          uniquePlayerCount: { $size: '$uniquePlayers' },
          popularityScore: {
            $add: [
              { $multiply: ['$playCount', 0.6] },
              { $multiply: ['$avgScore', 0.0001] },
              { $multiply: ['$uniquePlayerCount', 0.4] }
            ]
          }
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
        $match: {
          'music.status': 'published'
        }
      },
      {
        $sort: { popularityScore: -1 }
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    // Filter premium content for non-premium users
    const filteredCharts = topCharts.filter(item => {
      if (item.music.availability.premium) {
        return req.user && req.user.subscriptions.premium.active;
      }
      return true;
    });

    res.json({
      success: true,
      charts: filteredCharts,
      period
    });

  } catch (error) {
    console.error('Get top charts error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving top charts'
    });
  }
});

// @route   GET /api/music/random
// @desc    Get random music suggestions
// @access  Public
router.get('/random', optionalAuth, async (req, res) => {
  try {
    const { count = 5, difficulty, genre } = req.query;

    const filters = { status: 'published' };
    
    if (difficulty) filters['difficulty.level'] = difficulty;
    if (genre) filters.genre = genre;
    
    // Filter premium content for non-premium users
    if (!req.user || !req.user.subscriptions.premium.active) {
      filters['availability.premium'] = false;
    }

    const randomMusic = await Music.aggregate([
      { $match: filters },
      { $sample: { size: parseInt(count) } }
    ]);

    res.json({
      success: true,
      music: randomMusic
    });

  } catch (error) {
    console.error('Get random music error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving random music'
    });
  }
});

// @route   GET /api/music/:id/leaderboard
// @desc    Get leaderboard for specific music
// @access  Public
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 10 } = req.query;

    const music = await Music.findById(id);
    if (!music) {
      return res.status(404).json({
        success: false,
        message: 'Music not found'
      });
    }

    const Game = require('../models/Game');
    
    const leaderboard = await Game.aggregate([
      {
        $match: {
          musicId: music._id,
          'session.status': 'completed'
        }
      },
      {
        $group: {
          _id: '$userId',
          bestScore: { $max: '$scoring.totalScore' },
          bestAccuracy: { $max: '$gameplay.accuracy' },
          totalPlays: { $sum: 1 },
          lastPlayed: { $max: '$createdAt' }
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
          level: '$user.statistics.level',
          bestScore: 1,
          bestAccuracy: 1,
          totalPlays: 1,
          lastPlayed: 1
        }
      },
      {
        $sort: { bestScore: -1, bestAccuracy: -1 }
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    res.json({
      success: true,
      music: {
        id: music._id,
        title: music.title,
        artist: music.artist
      },
      leaderboard
    });

  } catch (error) {
    console.error('Get music leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving music leaderboard'
    });
  }
});

// @route   GET /api/music/artist/:artist
// @desc    Get music by artist
// @access  Public
router.get('/artist/:artist', optionalAuth, async (req, res) => {
  try {
    const { artist } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const filters = {
      status: 'published',
      artist: new RegExp(artist, 'i') // Case insensitive search
    };

    // Filter premium content for non-premium users
    if (!req.user || !req.user.subscriptions.premium.active) {
      filters['availability.premium'] = false;
    }

    const music = await Music.find(filters)
      .sort({ 'statistics.playCount': -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Music.countDocuments(filters);

    res.json({
      success: true,
      artist,
      music,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get music by artist error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving music by artist'
    });
  }
});

// @route   GET /api/music/stats/overview
// @desc    Get music library statistics
// @access  Public
router.get('/stats/overview', async (req, res) => {
  try {
    const stats = await Music.aggregate([
      {
        $match: { status: 'published' }
      },
      {
        $group: {
          _id: null,
          totalSongs: { $sum: 1 },
          totalDuration: { $sum: '$duration' },
          avgDifficulty: { $avg: '$difficulty.rating' },
          totalPlays: { $sum: '$statistics.playCount' },
          genreCount: { $addToSet: '$genre' },
          premiumCount: {
            $sum: {
              $cond: ['$availability.premium', 1, 0]
            }
          }
        }
      }
    ]);

    const overview = stats[0] || {
      totalSongs: 0,
      totalDuration: 0,
      avgDifficulty: 0,
      totalPlays: 0,
      genreCount: [],
      premiumCount: 0
    };

    res.json({
      success: true,
      stats: {
        totalSongs: overview.totalSongs,
        totalDuration: Math.round(overview.totalDuration),
        avgDifficulty: Math.round(overview.avgDifficulty * 10) / 10,
        totalPlays: overview.totalPlays,
        totalGenres: overview.genreCount.length,
        premiumSongs: overview.premiumCount,
        freeSongs: overview.totalSongs - overview.premiumCount
      }
    });

  } catch (error) {
    console.error('Get music stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving music statistics'
    });
  }
});

module.exports = router;