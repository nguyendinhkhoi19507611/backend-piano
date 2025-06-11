
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    // Tạo indexes cho performance
    await createIndexes();
    
  } catch (error) {
    console.error('Database connection error:', error.message);
    process.exit(1);
  }
};

const createIndexes = async () => {
  try {
    const db = mongoose.connection.db;
    
    // Index cho collection users
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('users').createIndex({ createdAt: -1 });
    
    // Index cho collection games
    await db.collection('games').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('games').createIndex({ status: 1 });
    
    // Index cho collection transactions
    await db.collection('transactions').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('transactions').createIndex({ status: 1 });
    await db.collection('transactions').createIndex({ type: 1 });
    
    // Index cho collection music
    await db.collection('music').createIndex({ title: 'text', artist: 'text' });
    await db.collection('music').createIndex({ genre: 1, difficulty: 1 });
    
    console.log('Database indexes created successfully');
  } catch (error) {
    console.error('Error creating indexes:', error.message);
  }
};

// Xử lý các sự kiện connection
mongoose.connection.on('connected', () => {
  console.log('Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (error) => {
  console.error('Mongoose connection error:', error);
});

mongoose.connection.on('disconnected', () => {
  console.log('Mongoose disconnected from MongoDB');
});

// Đóng connection khi app tắt
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed through app termination');
  process.exit(0);
});

module.exports = connectDB;