const mongoose = require('mongoose');

const streamSchema = new mongoose.Schema({
  // Reference to the user who created the stream
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Stream metadata
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  
  description: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  
  // Stream settings
  isPrivate: {
    type: Boolean,
    default: false
  },
  
  streamKey: {
    type: String,
    required: true,
    unique: true
  },
  
  // Stream status
  status: {
    type: String,
    enum: ['starting', 'live', 'ended', 'error'],
    default: 'starting'
  },
  
  // Recording information
  recordingUrl: String,
  thumbnailUrl: String,
  duration: Number, // in seconds
  
  // Viewership metrics
  viewers: {
    type: Number,
    default: 0
  },
  
  peakViewers: {
    type: Number,
    default: 0
  },
  
  // Timestamps
  startedAt: {
    type: Date,
    default: Date.now
  },
  
  endedAt: Date,
  
  // Additional metadata
  tags: [{
    type: String,
    trim: true
  }],
  
  // System fields
  isActive: {
    type: Boolean,
    default: true
  },
  
  // For soft delete
  deletedAt: Date,
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
streamSchema.index({ user: 1, status: 1 });
streamSchema.index({ status: 1, startedAt: -1 });
streamSchema.index({ title: 'text', description: 'text' });

// Virtual for stream URL
streamSchema.virtual('rtmpUrl').get(function() {
  return `rtmp://${process.env.RTMP_SERVER || 'your-server-address'}/live/${this.streamKey}`;
});

// Virtual for HLS playback URL
streamSchema.virtual('playbackUrl').get(function() {
  return `/live/${this.streamKey}/index.m3u8`;
});

// Virtual for duration in human-readable format
streamSchema.virtual('durationFormatted').get(function() {
  if (!this.duration) return '00:00';
  
  const hours = Math.floor(this.duration / 3600);
  const minutes = Math.floor((this.duration % 3600) / 60);
  const seconds = this.duration % 60;
  
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0')
  ].join(':');
});

// Pre-save hook to update duration before saving
streamSchema.pre('save', function(next) {
  if (this.endedAt && this.startedAt) {
    this.duration = Math.floor((this.endedAt - this.startedAt) / 1000);
  }
  next();
});

// Static method to get active streams
streamSchema.statics.getActiveStreams = async function() {
  return this.find({ 
    status: 'live',
    isActive: true 
  })
  .populate('user', 'username profilePicture')
  .sort({ startedAt: -1 });
};

// Static method to get user's streams
streamSchema.statics.getUserStreams = async function(userId, options = {}) {
  const { page = 1, limit = 10, status } = options;
  const query = { 
    user: userId,
    isActive: true 
  };
  
  if (status) {
    query.status = status;
  }
  
  return this.find(query)
    .sort({ startedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('user', 'username profilePicture');
};

// Method to end the stream
streamSchema.methods.endStream = async function() {
  this.status = 'ended';
  this.endedAt = new Date();
  return this.save();
};

// Method to update viewer count
streamSchema.methods.updateViewerCount = async function(count) {
  this.viewers = count;
  
  if (count > this.peakViewers) {
    this.peakViewers = count;
  }
  
  return this.save();
};

const Stream = mongoose.model('Stream', streamSchema);

module.exports = Stream;
