require('dotenv').config();
require('module-alias/register');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, 'config/.env') });

// Import configurations
const config = require('./config/config');
const logger = require('./utils/logger');

// Import routes
const authRoutes = require('./routes/authRoutes');
const streamRoutes = require('./routes/streamRoutes');
const userRoutes = require('./routes/userRoutes');

// Import services
const RTMPServer = require('./services/rtmpServer');
const WebSocketServer = require('./services/webSocketServer');

// Import middleware
const { errorHandler, notFound } = require('./middleware/errorMiddleware');

// Create Express app
const app = express();

// Trust proxy (for Heroku, AWS, etc.)
app.set('trust proxy', 1);

// Enable CORS
app.use(cors({
  origin: config.clientUrl,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['set-cookie']
}));

// Set security HTTP headers
app.use(helmet());
      this.app.get('*', (req, res) => {
        res.sendFile(path.resolve(__dirname, '../client/build/index.html'));
      });
    } else {
      this.app.get('/', (req, res) => {
        res.send('Live Stream API is running in development mode');
      });
    }
  }

  initializeServers() {
    try {
      // Initialize RTMP Server with WebSocket integration
      this.rtmpServer = new RTMPServer(this.io);
      
      // Initialize WebSocket Server
      this.wsServer = new WebSocketServer(this.io, this.rtmpServer);
      
      logger.info('RTMP and WebSocket servers initialized');
    } catch (error) {
      logger.error('Error initializing streaming servers:', error);
      process.exit(1);
    }
  }

  initializeErrorHandling() {
    // Handle 404
    this.app.use((req, res, next) => {
      res.status(404).json({
        status: 'error',
        message: `Can't find ${req.originalUrl} on this server!`
      });
    });
    
    // Global error handler
    this.app.use((err, req, res, next) => {
      err.statusCode = err.statusCode || 500;
      err.status = err.status || 'error';
      
      // Log the error
      logger.error(`${err.statusCode} - ${err.message}`, {
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        stack: err.stack
      });
      
      // Send error response
      if (process.env.NODE_ENV === 'development') {
        res.status(err.statusCode).json({
          status: err.status,
          error: err,
          message: err.message,
          stack: err.stack
        });
      } else {
        // Production: Don't leak error details
        res.status(err.statusCode).json({
          status: err.status,
          message: err.isOperational ? err.message : 'Something went wrong!'
        });
      }
    });
  }

  start() {
    const PORT = process.env.PORT || config.http.port;
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (err) => {
      logger.error('UNHANDLED REJECTION! 💥 Shutting down...');
      logger.error(err.name, err.message);
      
      // Close server & exit process
      this.server.close(() => {
        process.exit(1);
      });
    });
    
    // Start the server
    this.server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
      
      // Log the process information
      logger.info(`Process ID: ${process.pid}`);
      logger.info(`Node version: ${process.version}`);
      logger.info(`Platform: ${process.platform}`);
      logger.info(`Memory usage: ${JSON.stringify(process.memoryUsage())}`);
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
      logger.error(err.name, err.message);
      
      // Close server & exit process
      this.server.close(() => {
        process.exit(1);
      });
    });
    
    // Handle SIGTERM (for Heroku, etc.)
    process.on('SIGTERM', () => {
      logger.info('👋 SIGTERM RECEIVED. Shutting down gracefully');
      this.server.close(() => {
        logger.info('💥 Process terminated!');
      });
    });
  }
}

// Start the server
const liveStreamServer = new LiveStreamServer();
liveStreamServer.start();

module.exports = liveStreamServer;
