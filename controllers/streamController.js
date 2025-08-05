const { validationResult } = require('express-validator');
const User = require('../models/User');
const Stream = require('../models/Stream');
const recordingService = require('../services/recordingService');

class StreamController {
  constructor(rtmpServer) {
    this.rtmpServer = rtmpServer;
  }

  // @desc    Get all active streams
  // @route   GET /api/streams/active
  // @access  Public
  async getActiveStreams(req, res) {
    try {
      const activeStreams = this.rtmpServer.getActiveStreams();
      
      // Add user details to each stream
      const streamsWithUserDetails = await Promise.all(
        activeStreams.map(async (stream) => {
          const user = await User.findById(stream.userId)
            .select('username profilePicture followers')
            .lean();
          
          return {
            ...stream,
            user: {
              _id: user._id,
              username: user.username,
              profilePicture: user.profilePicture,
              followersCount: user.followers?.length || 0
            }
          };
        })
      );
      
      res.json({ success: true, streams: streamsWithUserDetails });
    } catch (error) {
      console.error('Error getting active streams:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }

  // @desc    Get stream by ID
  // @route   GET /api/streams/:id
  // @access  Public
  async getStreamById(req, res) {
    try {
      const stream = await Stream.findById(req.params.id)
        .populate('user', 'username profilePicture followers')
        .lean();
      
      if (!stream) {
        return res.status(404).json({ 
          success: false, 
          message: 'Stream not found' 
        });
      }
      
      // If stream is private, check if user has access
      if (stream.isPrivate) {
        if (!req.user || 
            (req.user.id !== stream.user._id.toString() && 
             req.user.role !== 'admin')) {
          return res.status(403).json({ 
            success: false, 
            message: 'This is a private stream' 
          });
        }
      }
      
      res.json({ success: true, stream });
    } catch (error) {
      console.error('Error getting stream:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }

  // @desc    Start a new stream
  // @route   POST /api/streams/start
  // @access  Private (Streamer/Admin)
  async startStream(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    try {
      const { title, description, isPrivate } = req.body;
      const userId = req.user.id;
      
      // Get user with stream key
      const user = await User.findById(userId).select('+streamKey');
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          message: 'User not found' 
        });
      }
      
      // Check if user is already streaming
      const activeStreams = this.rtmpServer.getActiveStreams();
      const isAlreadyStreaming = activeStreams.some(
        stream => stream.userId === userId
      );
      
      if (isAlreadyStreaming) {
        return res.status(400).json({ 
          success: false, 
          message: 'You are already streaming' 
        });
      }
      
      // Create stream record in database
      const stream = new Stream({
        user: userId,
        title,
        description: description || '',
        isPrivate: !!isPrivate,
        streamKey: user.streamKey,
        status: 'starting'
      });
      
      await stream.save();
      
      // The actual stream will be started when the RTMP connection is established
      // The RTMPServer will handle the actual stream start event
      
      res.json({
        success: true,
        message: 'Stream is starting',
        stream: {
          id: stream._id,
          title: stream.title,
          isPrivate: stream.isPrivate,
          streamKey: user.streamKey,
          rtmpUrl: `rtmp://${process.env.RTMP_SERVER || 'your-server-address'}/live/${user.streamKey}`
        }
      });
    } catch (error) {
      console.error('Error starting stream:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }

  // @desc    End a stream
  // @route   POST /api/streams/:id/end
  // @access  Private (Streamer/Admin)
  async endStream(req, res) {
    try {
      const stream = await Stream.findById(req.params.id);
      
      if (!stream) {
        return res.status(404).json({ 
          success: false, 
          message: 'Stream not found' 
        });
      }
      
      // Check if user owns the stream or is admin
      if (req.user.id !== stream.user.toString() && req.user.role !== 'admin') {
        return res.status(403).json({ 
          success: false, 
          message: 'Not authorized to end this stream' 
        });
      }
      
      // Update stream status
      stream.status = 'ended';
      stream.endedAt = new Date();
      await stream.save();
      
      // The RTMPServer will handle the actual stream end event
      // and clean up resources
      
      res.json({ 
        success: true, 
        message: 'Stream ended successfully' 
      });
    } catch (error) {
      console.error('Error ending stream:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }

  // @desc    Get stream recordings
  // @route   GET /api/streams/recordings
  // @access  Private (Streamer/Admin)
  async getRecordings(req, res) {
    try {
      const userId = req.user.id;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      
      const query = { user: userId };
      
      // Get total count for pagination
      const total = await Stream.countDocuments(query);
      
      // Get paginated streams
      const streams = await Stream.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('title description createdAt duration viewers thumbnailUrl isPrivate');
      
      res.json({
        success: true,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        streams
      });
    } catch (error) {
      console.error('Error getting recordings:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
}

module.exports = StreamController;
