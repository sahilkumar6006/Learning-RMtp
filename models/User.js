const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['user', 'streamer', 'admin'],
    default: 'user'
  },
  profilePicture: {
    type: String,
    default: 'default.jpg'
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  streamKey: {
    type: String,
    unique: true
  },
  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate JWT token
userSchema.methods.generateAuthToken = function() {
  return jwt.sign(
    { id: this._id, role: this.role },
    config.auth.secret,
    { expiresIn: '7d' }
  );
};

// Generate stream key if not exists
userSchema.pre('save', function(next) {
  if (!this.streamKey) {
    this.streamKey = `live_${this._id.toString().substring(0, 10)}_${Math.random().toString(36).substr(2, 10)}`;
  }
  next();
});

// Virtual for stream URL
userSchema.virtual('rtmpUrl').get(function() {
  return `rtmp://${process.env.RTMP_SERVER || 'your-server-address'}/live/${this.streamKey}`;
});

const User = mongoose.model('User', userSchema);

module.exports = User;
