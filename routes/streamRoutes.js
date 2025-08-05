const express = require('express');
const router = express.Router();
const RTMPServer = require('../services/rtmpServer');
const StreamController = require('../controllers/streamController');

// Initialize controller with RTMP server instance
const rtmpServer = new RTMPServer();
const streamController = new StreamController(rtmpServer);

// Stream management routes
router.post('/streams/generate-key', (req, res) => streamController.generateStreamKey(req, res));
router.get('/streams/active', (req, res) => streamController.getActiveStreams(req, res));
router.get('/streams/:streamKey', (req, res) => streamController.getStreamInfo(req, res));
router.delete('/streams/:streamKey/end', (req, res) => streamController.endStream(req, res));

// Add authentication middleware for protected routes
// router.use(require('../middleware/auth'));

module.exports = router;
