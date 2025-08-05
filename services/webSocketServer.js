const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Stream = require('../models/Stream');
const config = require('../config/config');
const logger = require('../utils/logger');

class WebSocketServer {
  constructor(io, rtmpServer) {
    this.io = io;
    this.rtmpServer = rtmpServer;
    this.connectedUsers = new Map(); // userId -> socketId[]
    this.roomSubscribers = new Map(); // roomId -> Set(socketId)
    
    this.initializeSocketHandlers();
  }

  // Authenticate socket connection
  async authenticateSocket(socket, token) {
    try {
      if (!token) {
        throw new Error('No token provided');
      }
      
      // Verify JWT token
      const decoded = jwt.verify(token, config.auth.secret);
      
      // Get user from database
      const user = await User.findById(decoded.id).select('-password');
      if (!user) {
        throw new Error('User not found');
      }
      
      // Store user data in socket
      socket.user = user;
      
      // Track connected users
      if (!this.connectedUsers.has(user._id.toString())) {
        this.connectedUsers.set(user._id.toString(), new Set());
      }
      this.connectedUsers.get(user._id.toString()).add(socket.id);
      
      return user;
    } catch (error) {
      logger.error('Socket authentication error:', error);
      throw new Error('Authentication failed');
    }
  }
  
  // Handle user joining a stream room
  async handleJoinStream(socket, streamId) {
    try {
      if (!socket.user) {
        throw new Error('Not authenticated');
      }
      
      const stream = await Stream.findById(streamId);
      if (!stream) {
        throw new Error('Stream not found');
      }
      
      // Check if stream is private and user has access
      if (stream.isPrivate && 
          stream.user.toString() !== socket.user._id.toString() && 
          socket.user.role !== 'admin') {
        throw new Error('Access to private stream denied');
      }
      
      const roomName = `stream:${streamId}`;
      
      // Join the room
      await socket.join(roomName);
      
      // Track room subscribers
      if (!this.roomSubscribers.has(roomName)) {
        this.roomSubscribers.set(roomName, new Set());
      }
      this.roomSubscribers.get(roomName).add(socket.id);
      
      // Notify others in the room
      socket.to(roomName).emit('user-joined', {
        userId: socket.user._id,
        username: socket.user.username,
        timestamp: Date.now()
      });
      
      // Send current stream info to the user
      const streamInfo = await this.rtmpServer.getStreamInfo(stream.streamKey);
      if (streamInfo) {
        socket.emit('stream-info', streamInfo);
      }
      
      // Update viewer count
      const viewerCount = this.roomSubscribers.get(roomName).size;
      this.io.to(roomName).emit('viewer-count', { count: viewerCount });
      
      logger.info(`User ${socket.user._id} joined stream ${streamId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('Error joining stream:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Handle chat messages
  async handleChatMessage(socket, { streamId, message }) {
    try {
      if (!socket.user) {
        throw new Error('Not authenticated');
      }
      
      if (!message || !message.trim()) {
        throw new Error('Message cannot be empty');
      }
      
      const roomName = `stream:${streamId}`;
      const rooms = Array.from(socket.rooms);
      
      // Check if user is in the stream room
      if (!rooms.includes(roomName)) {
        throw new Error('Not in the stream room');
      }
      
      // Create chat message object
      const chatMessage = {
        userId: socket.user._id,
        username: socket.user.username,
        userRole: socket.user.role,
        avatar: socket.user.profilePicture,
        message: message.trim(),
        timestamp: Date.now()
      };
      
      // Broadcast message to room
      this.io.to(roomName).emit('chat-message', chatMessage);
      
      // Log the message (you might want to save it to the database here)
      logger.info(`Chat message in ${roomName} from ${socket.user.username}: ${message}`);
      
      return { success: true, message: chatMessage };
    } catch (error) {
      logger.error('Error sending chat message:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Handle reactions
  async handleReaction(socket, { streamId, reaction }) {
    try {
      if (!socket.user) {
        throw new Error('Not authenticated');
      }
      
      const roomName = `stream:${streamId}`;
      const rooms = Array.from(socket.rooms);
      
      // Check if user is in the stream room
      if (!rooms.includes(roomName)) {
        throw new Error('Not in the stream room');
      }
      
      // Broadcast reaction to room (except sender)
      socket.to(roomName).emit('reaction', {
        userId: socket.user._id,
        username: socket.user.username,
        reaction,
        timestamp: Date.now()
      });
      
      return { success: true };
    } catch (error) {
      logger.error('Error handling reaction:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Handle socket disconnection
  handleDisconnect(socket) {
    if (socket.user) {
      const userId = socket.user._id.toString();
      
      // Remove socket from connected users
      if (this.connectedUsers.has(userId)) {
        const userSockets = this.connectedUsers.get(userId);
        userSockets.delete(socket.id);
        
        if (userSockets.size === 0) {
          this.connectedUsers.delete(userId);
        }
      }
      
      // Remove from room subscribers
      this.roomSubscribers.forEach((subscribers, roomName) => {
        if (subscribers.has(socket.id)) {
          subscribers.delete(socket.id);
          
          // Update viewer count
          const viewerCount = subscribers.size;
          this.io.to(roomName).emit('viewer-count', { count: viewerCount });
          
          // Notify others in the room
          this.io.to(roomName).emit('user-left', {
            userId: socket.user._id,
            username: socket.user.username,
            timestamp: Date.now()
          });
          
          // Clean up empty rooms
          if (subscribers.size === 0) {
            this.roomSubscribers.delete(roomName);
          }
        }
      });
      
      logger.info(`User ${socket.user._id} (${socket.id}) disconnected`);
    } else {
      logger.info(`Unauthenticated socket ${socket.id} disconnected`);
    }
  }
  
  initializeSocketHandlers() {
    this.io.on('connection', async (socket) => {
      logger.info(`New socket connection: ${socket.id}`);
      
      // Handle authentication
      socket.on('authenticate', async ({ token }, callback) => {
        try {
          const user = await this.authenticateSocket(socket, token);
          logger.info(`Socket ${socket.id} authenticated as user ${user._id}`);
          
          // Send success response
          if (typeof callback === 'function') {
            callback({ success: true, user: { id: user._id, username: user.username } });
          }
        } catch (error) {
          logger.error(`Authentication failed for socket ${socket.id}:`, error);
          
          // Send error response
          if (typeof callback === 'function') {
            callback({ success: false, error: error.message });
          }
          
          // Disconnect unauthenticated socket
          socket.disconnect(true);
        }
      });
      
      // Join stream room
      socket.on('join-stream', async (data, callback) => {
        const result = await this.handleJoinStream(socket, data.streamId);
        if (typeof callback === 'function') {
          callback(result);
        }
      });
      
      // Leave stream room
      socket.on('leave-stream', (streamId) => {
        const roomName = `stream:${streamId}`;
        socket.leave(roomName);
        
        // Update room subscribers
        if (this.roomSubscribers.has(roomName)) {
          const subscribers = this.roomSubscribers.get(roomName);
          subscribers.delete(socket.id);
          
          // Update viewer count
          const viewerCount = subscribers.size;
          this.io.to(roomName).emit('viewer-count', { count: viewerCount });
          
          // Clean up empty rooms
          if (subscribers.size === 0) {
            this.roomSubscribers.delete(roomName);
          }
        }
        
        logger.info(`Socket ${socket.id} left stream ${streamId}`);
      });
      
      // Handle chat messages
      socket.on('chat-message', async (data, callback) => {
        const result = await this.handleChatMessage(socket, data);
        if (typeof callback === 'function') {
          callback(result);
        }
      });
      
      // Handle reactions
      socket.on('send-reaction', async (data, callback) => {
        const result = await this.handleReaction(socket, data);
        if (typeof callback === 'function') {
          callback(result);
        }
      });
      
      // Handle disconnection
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
      
      // Error handling
      socket.on('error', (error) => {
        logger.error(`Socket error (${socket.id}):`, error);
      });
    });
  }

  // Notify clients about stream events
  notifyStreamStarted(streamData) {
    const roomName = `stream:${streamData.id}`;
    this.io.emit('stream-started', streamData);
    logger.info(`Stream started: ${streamData.id}`);
  }
  
  notifyStreamEnded(streamData) {
    const roomName = `stream:${streamData.id}`;
    this.io.to(roomName).emit('stream-ended', streamData);
    this.io.emit('stream-ended-global', streamData);
    logger.info(`Stream ended: ${streamData.id}`);
  }
  
  // Update stream info (quality, bitrate, etc.)
  updateStreamInfo(streamId, info) {
    const roomName = `stream:${streamId}`;
    this.io.to(roomName).emit('stream-update', info);
  }
  
  // Get number of viewers for a stream
  getViewerCount(streamId) {
    const roomName = `stream:${streamId}`;
    return this.roomSubscribers.get(roomName)?.size || 0;
  }
}

module.exports = WebSocketServer;
