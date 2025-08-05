const NodeMediaServer = require('node-media-server');
const jwt = require('jsonwebtoken');
const Stream = require('../models/Stream');
const User = require('../models/User');
const config = require('../config/config');
const logger = require('../utils/logger');
const recordingService = require('./recordingService');

class RTMPServer {
  constructor(io) {
    this.io = io;
    this.nms = new NodeMediaServer(config.rtmpServer);
    this.streamSessions = new Map(); // streamKey -> session info
    this.activeStreams = new Map();
    this.initializeEventHandlers();
  }

  // Authenticate stream playback
  async authenticatePlay(id, StreamPath, args) {
    const streamKey = this.extractStreamKey(StreamPath);
    const session = this.streamSessions.get(id);
    
    try {
      // Check if stream exists and is active
      const stream = this.activeStreams.get(streamKey);
      if (!stream) {
        console.log(`[AUTH] Stream not found: ${streamKey}`);
        return false;
      }
      
      // Get user from session or token
      const user = await this.authenticateUser(args);
      if (!user) {
        console.log(`[AUTH] Unauthorized access to stream: ${streamKey}`);
        return false;
      }
      
      // Store session info
      this.streamSessions.set(id, {
        ...session,
        type: 'play',
        streamKey,
        userId: user._id,
        userRole: user.role,
        startTime: Date.now()
      });
      
      // Increment viewer count
      this.updateViewerCount(streamKey, 1);
      
      console.log(`[AUTH] Playback authorized for user ${user._id} on stream ${streamKey}`);
      return true;
    } catch (error) {
      console.error('Play authentication error:', error);
      return false;
    }
  }
  
  // Authenticate stream publishing
  async authenticatePublish(id, StreamPath, args) {
    const streamKey = this.extractStreamKey(StreamPath);
    
    try {
      // Get user from session or token
      const user = await this.authenticateUser(args);
      if (!user) {
        console.log(`[AUTH] Unauthorized publish attempt: ${streamKey}`);
        return false;
      }
      
      // Check if user has permission to publish
      if (user.role !== 'streamer' && user.role !== 'admin') {
        console.log(`[AUTH] User ${user._id} is not authorized to publish`);
        return false;
      }
      
      // Verify stream key belongs to user
      if (user.streamKey !== streamKey) {
        console.log(`[AUTH] Invalid stream key for user ${user._id}`);
        return false;
      }
      
      // Store session info
      this.streamSessions.set(id, {
        type: 'publish',
        streamKey,
        userId: user._id,
        userRole: user.role,
        startTime: Date.now()
      });
      
      console.log(`[AUTH] Publish authorized for user ${user._id} with stream ${streamKey}`);
      return true;
    } catch (error) {
      console.error('Publish authentication error:', error);
      return false;
    }
  }
  
  // Helper to authenticate user from token or session
  async authenticateUser(args) {
    try {
      // Check for token in query params or headers
      const token = args.token || (args.headers && args.headers.token);
      if (!token) return null;
      
      // Verify JWT token
      const decoded = jwt.verify(token, config.auth.secret);
      
      // Get user from database
      return await User.findById(decoded.id).select('+streamKey');
    } catch (error) {
      console.error('User authentication error:', error);
      return null;
    }
  }
  
  // Extract stream key from RTMP path
  extractStreamKey(streamPath) {
    const parts = streamPath.split('/');
    return parts[parts.length - 1];
  }
  
  // Authenticate publisher (streamer)
  async authenticatePublisher(streamKey, token) {
    try {
      if (!token) {
        throw new Error('No token provided');
      }
      
      // Verify JWT token
      const decoded = jwt.verify(token, config.auth.secret);
      
      // Get user and stream from database
      const [user, stream] = await Promise.all([
        User.findById(decoded.id).select('-password'),
        Stream.findOne({ streamKey })
      ]);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Check if stream exists and belongs to user
      if (!stream) {
        // Create a new stream if it doesn't exist (first time streaming)
        const newStream = new Stream({
          user: user._id,
          title: `Stream ${Date.now()}`,
          description: '',
          streamKey,
          isLive: false,
          isPrivate: false,
          tags: []
        });
        
        await newStream.save();
        return { user, stream: newStream };
      }
      
      // Check if stream belongs to user or user is admin
      if (stream.user.toString() !== user._id.toString() && user.role !== 'admin') {
        throw new Error('Unauthorized to stream to this channel');
      }
      
      return { user, stream };
    } catch (error) {
      logger.error('Publisher authentication error:', error);
      throw error;
    }
  }
  
  // Authenticate viewer
  async authenticateViewer(streamKey, token) {
    try {
      // Get stream from database
      const stream = await Stream.findOne({ streamKey }).populate('user', 'username profilePicture');
      
      if (!stream) {
        throw new Error('Stream not found');
      }
      
      // Public stream doesn't require authentication
      if (!stream.isPrivate) {
        return { stream };
      }
      
      // Private stream requires authentication
      if (!token) {
        throw new Error('Authentication required for private stream');
      }
      
      // Verify JWT token
      const decoded = jwt.verify(token, config.auth.secret);
      const user = await User.findById(decoded.id).select('-password');
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Check if user is the streamer, admin, or a follower (for private streams)
      const isOwner = stream.user._id.toString() === user._id.toString();
      const isAdmin = user.role === 'admin';
      const isFollower = stream.user.followers.includes(user._id);
      
      if (!isOwner && !isAdmin && !isFollower) {
        throw new Error('Not authorized to view this private stream');
      }
      
      return { user, stream };
    } catch (error) {
      logger.error('Viewer authentication error:', error);
      throw error;
    }
  }
  
  // Get stream info by stream key
  async getStreamInfo(streamKey) {
    try {
      const stream = await Stream.findOne({ streamKey })
        .populate('user', 'username profilePicture')
        .select('-__v -streamKey');
      
      if (!stream) {
        return null;
      }
      
      const session = this.streamSessions.get(streamKey);
      const streamInfo = {
        id: stream._id,
        title: stream.title,
        description: stream.description,
        isLive: stream.isLive,
        isPrivate: stream.isPrivate,
        thumbnail: stream.thumbnail,
        tags: stream.tags,
        user: stream.user,
        viewerCount: 0, // Will be updated by WebSocket server
        startedAt: stream.startedAt,
        duration: stream.isLive ? Math.floor((Date.now() - new Date(stream.startedAt).getTime()) / 1000) : 0,
        session: session ? {
          width: session.width,
          height: session.height,
          videoCodec: session.videoCodec,
          audioCodec: session.audioCodec,
          videoBitrate: session.videoBitrate,
          audioBitrate: session.audioBitrate,
          frameRate: session.frameRate
        } : null
      };
      
      return streamInfo;
    } catch (error) {
      logger.error('Error getting stream info:', error);
      return null;
    }
  }
  
  // Update stream metadata
  async updateStreamMetadata(streamKey, metadata) {
    try {
      const stream = await Stream.findOne({ streamKey });
      
      if (!stream) {
        throw new Error('Stream not found');
      }
      
      // Update allowed fields
      const allowedUpdates = ['title', 'description', 'isPrivate', 'tags', 'thumbnail'];
      const updates = {};
      
      for (const key in metadata) {
        if (allowedUpdates.includes(key)) {
          updates[key] = metadata[key];
        }
      }
      
      if (Object.keys(updates).length > 0) {
        Object.assign(stream, updates);
        await stream.save();
        
        // Notify viewers about metadata update
        const roomName = `stream:${stream._id}`;
        this.io.to(roomName).emit('stream-metadata-updated', {
          streamId: stream._id,
          updates: updates,
          updatedAt: new Date()
        });
        
        logger.info(`Stream metadata updated: ${streamKey}`, { updates });
      }
      
      return stream;
    } catch (error) {
      logger.error('Error updating stream metadata:', error);
      throw error;
    }
  }
  
  // End a stream
  async endStream(streamKey) {
    try {
      const stream = await Stream.findOne({ streamKey });
      
      if (!stream) {
        throw new Error('Stream not found');
      }
      
      if (!stream.isLive) {
        throw new Error('Stream is not live');
      }
      
      // Update stream status
      stream.isLive = false;
      stream.endedAt = new Date();
      await stream.save();
      
      // Get session info before removing it
      const session = this.streamSessions.get(streamKey);
      
      // Remove session
      this.streamSessions.delete(streamKey);
      
      // Notify WebSocket server
      if (this.io) {
        this.io.emit('stream-ended', {
          streamId: stream._id,
          endedAt: stream.endedAt,
          duration: Math.floor((stream.endedAt - stream.startedAt) / 1000)
        });
      }
      
      logger.info(`Stream ended: ${streamKey}`);
      
      return {
        success: true,
        streamId: stream._id,
        duration: Math.floor((stream.endedAt - stream.startedAt) / 1000),
        session
      };
    } catch (error) {
      logger.error('Error ending stream:', error);
      throw error;
    }
  }
  
  initializeEventHandlers() {
    // Handle new RTMP connections
    this.nms.on('preConnect', (id, args) => {
      logger.debug(`[RTMP] New connection: ${id}`, { args });
    });
    
    // Handle RTMP disconnections
    this.nms.on('doneConnect', (id, args) => {
      logger.debug(`[RTMP] Connection closed: ${id}`, { args });
    });
    
    // Handle pre-publish (when a streamer starts streaming)
    this.nms.on('prePublish', async (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      const { token } = args;
      
      logger.info(`[RTMP] Pre-publish: ${streamKey}`, { id, args });
      
      try {
        // Authenticate publisher
        const { user, stream } = await this.authenticatePublisher(streamKey, token);
        
        // Store session info
        this.streamSessions.set(streamKey, {
          id,
          streamId: stream._id,
          userId: user._id,
          startTime: new Date(),
          args
        });
        
        // Update stream status
        stream.isLive = true;
        stream.startedAt = new Date();
        await stream.save();
        
        logger.info(`[RTMP] Stream started: ${streamKey} by user ${user._id}`, {
          streamId: stream._id,
          title: stream.title
        });
      } catch (error) {
        logger.error(`[RTMP] Pre-publish authentication failed: ${streamKey}`, { error: error.message });
        const session = this.nms.getSession(id);
        if (session) {
          session.reject();
        }
      }
    });
    
    // Handle post-publish (successful stream start)
    this.nms.on('postPublish', (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      const session = this.streamSessions.get(streamKey) || {};
      
      // Update session with stream info
      const streamInfo = this.nms.getSession(id)?.streams?.video || {};
      if (streamInfo) {
        session.width = streamInfo.width;
        session.height = streamInfo.height;
        session.videoCodec = streamInfo.codec;
        session.videoBitrate = streamInfo.bitrate;
        session.frameRate = streamInfo.fps;
      }
      
      const audioInfo = this.nms.getSession(id)?.streams?.audio;
      if (audioInfo) {
        session.audioCodec = audioInfo.codec;
        session.audioBitrate = audioInfo.bitrate;
      }
      
      logger.info(`[RTMP] Post-publish: ${streamKey}`, {
        id,
        session: {
          width: session.width,
          height: session.height,
          videoCodec: session.videoCodec,
          audioCodec: session.audioCodec,
          videoBitrate: session.videoBitrate,
          audioBitrate: session.audioBitrate,
          frameRate: session.frameRate
        }
      });
      
      // Notify WebSocket server
      if (this.io && session.streamId) {
        this.io.emit('stream-started', {
          streamId: session.streamId,
          startedAt: session.startTime,
          metadata: {
            width: session.width,
            height: session.height,
            videoCodec: session.videoCodec,
            audioCodec: session.audioCodec
          }
        });
      }
    });
    
    // Handle stream end
    this.nms.on('donePublish', async (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      const session = this.streamSessions.get(streamKey);
      
      logger.info(`[RTMP] Done publish: ${streamKey}`, { id, session });
      
      if (session) {
        try {
          // End the stream
          await this.endStream(streamKey);
        } catch (error) {
          logger.error(`[RTMP] Error in donePublish for ${streamKey}:`, error);
        } finally {
          // Clean up session
          this.streamSessions.delete(streamKey);
        }
      }
    });
    
    // Handle pre-play (when a viewer starts watching)
    this.nms.on('prePlay', (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      const { token } = args;
      
      logger.debug(`[RTMP] Pre-play: ${streamKey}`, { id, args });
      
      // Authenticate viewer (non-blocking)
      this.authenticateViewer(streamKey, token)
        .then(({ stream }) => {
          logger.info(`[RTMP] Play authorized: ${streamKey}`, { streamId: stream._id });
        })
        .catch((error) => {
          logger.warn(`[RTMP] Play unauthorized: ${streamKey}`, { error: error.message });
          const session = this.nms.getSession(id);
          if (session) {
            session.reject();
          }
        });
    });
    
    // Handle post-play (successful playback start)
    this.nms.on('postPlay', (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      logger.debug(`[RTMP] Post-play: ${streamKey}`, { id });
      
      // Note: Viewer count is managed by WebSocket server for more accuracy
    });
    
    // Handle playback end
    this.nms.on('donePlay', (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      logger.debug(`[RTMP] Done play: ${streamKey}`, { id });
    });
    
    this.nms.on('prePublish', async (id, StreamPath, args) => {
      const streamKey = this.extractStreamKey(StreamPath);
      const session = this.streamSessions.get(id);
      
      if (!session || session.type !== 'publish') {
        console.log(`[RTMP] Unauthorized publish attempt: ${streamKey}`);
        return;
      }
      
      console.log(`[RTMP] Stream started: ${streamKey} by user ${session.userId}`);
      
      const streamId = uuidv4();
      const streamData = {
        id: streamId,
        streamKey,
        userId: session.userId,
        userRole: session.userRole,
        path: StreamPath,
        startTime: Date.now(),
        viewers: 0,
        metadata: {
          title: args.title || 'Untitled Stream',
          description: args.description || '',
          isPrivate: args.private === 'true'
        }
      };
      
      this.activeStreams.set(streamKey, streamData);
      
      // Start recording the stream
      recordingService.startRecording(streamKey, session.userId);
      
      // Notify all clients about new stream
      this.io.emit('stream-started', {
        streamId,
        streamKey,
        userId: session.userId,
        title: streamData.metadata.title,
        isPrivate: streamData.metadata.isPrivate,
        startTime: streamData.startTime,
        thumbnail: `http://your-server-address/thumbnails/${streamId}.jpg`
      });
    });

    this.nms.on('donePublish', (id, StreamPath, args) => {
      const session = this.streamSessions.get(id);
      const streamKey = session?.streamKey || this.extractStreamKey(StreamPath);
      
      console.log(`[RTMP] Stream ended: ${streamKey}`);
      
      if (this.activeStreams.has(streamKey)) {
        const stream = this.activeStreams.get(streamKey);
        const duration = Date.now() - stream.startTime;
        
        // Stop recording the stream
        recordingService.stopRecording(streamKey);
        
        // Notify all clients that stream has ended
        this.io.emit('stream-ended', {
          streamKey,
          streamId: stream.id,
          userId: stream.userId,
          duration,
          endTime: Date.now(),
          viewers: stream.viewers || 0
        });
        
        // Clean up
        this.activeStreams.delete(streamKey);
        this.streamSessions.delete(id);
      }
    });
    
    // Handle client disconnection
    this.nms.on('doneConnect', (id, args) => {
      const session = this.streamSessions.get(id);
      if (session) {
        // Decrement viewer count for play sessions
        if (session.type === 'play' && session.streamKey) {
          this.updateViewerCount(session.streamKey, -1);
        }
        this.streamSessions.delete(id);
      }
    });
  }

  getActiveStreams() {
    return Array.from(this.activeStreams.entries()).map(([key, value]) => ({
      streamKey: key,
      ...value
    }));
  }

  getStreamInfo(streamKey) {
    return this.activeStreams.get(streamKey) || null;
  }

  updateViewerCount(streamKey, delta) {
    if (this.activeStreams.has(streamKey)) {
      const stream = this.activeStreams.get(streamKey);
      stream.viewers = Math.max(0, stream.viewers + delta);
      
      // Broadcast updated viewer count
      this.io.emit('viewer-count-update', {
        streamKey,
        viewers: stream.viewers
      });
      
      return stream.viewers;
    }
    return 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.nms.run();
      
      // Wait for server to be ready
      this.nms.on('server_done', () => {
        logger.info('RTMP Server is running', { port: 1935 });
        resolve();
      });
      
      this.nms.on('error', (error) => {
        logger.error('RTMP Server error:', error);
        reject(error);
      });
    });
  }
  
  async stop() {
    try {
      // End all active streams gracefully
      const endPromises = [];
      for (const [streamKey] of this.streamSessions) {
        endPromises.push(this.endStream(streamKey).catch(error => {
          logger.error(`Error ending stream ${streamKey}:`, error);
        }));
      }
      
      await Promise.all(endPromises);
      
      // Stop the server
      this.nms.stop();
      logger.info('RTMP Server stopped');
      return true;
    } catch (error) {
      logger.error('Error stopping RTMP server:', error);
      throw error;
    }
  }
  
  // Get all active streams
  getActiveStreams() {
    const activeStreams = [];
    
    for (const [streamKey, session] of this.streamSessions.entries()) {
      activeStreams.push({
        streamKey,
        streamId: session.streamId,
        userId: session.userId,
        startTime: session.startTime,
        duration: Math.floor((Date.now() - new Date(session.startTime).getTime()) / 1000),
        stats: {
          width: session.width,
          height: session.height,
          videoCodec: session.videoCodec,
          audioCodec: session.audioCodec,
          videoBitrate: session.videoBitrate,
          audioBitrate: session.audioBitrate,
          frameRate: session.frameRate
        }
      });
    }
    
    return activeStreams;
  }
}

module.exports = RTMPServer;
