const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');

class RecordingService {
  constructor() {
    this.recordings = new Map();
    this.ensureDirectoriesExist();
  }

  ensureDirectoriesExist() {
    const dirs = [
      path.join(__dirname, '../recordings'),
      path.join(__dirname, '../recordings/videos'),
      path.join(__dirname, '../recordings/thumbnails')
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  // Start recording a stream
  startRecording(streamKey, userId) {
    if (this.recordings.has(streamKey)) {
      console.log(`Recording already in progress for stream: ${streamKey}`);
      return false;
    }

    const recordingId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${userId}_${timestamp}_${recordingId}.mp4`;
    const outputPath = path.join(__dirname, `../recordings/videos/${filename}`);
    
    // RTMP input URL
    const inputUrl = `rtmp://localhost/live/${streamKey}`;
    
    // FFmpeg command to record the stream
    const command = ffmpeg()
      .input(inputUrl)
      .inputOptions([
        '-re', // Read input at native frame rate
        '-timeout 3000000' // 3000 seconds timeout
      ])
      .outputOptions([
        '-c:v copy', // Copy video codec
        '-c:a aac', // Convert audio to AAC
        '-f mp4', // Output format
        '-movflags frag_keyframe+empty_moov', // For streaming output
        '-reset_timestamps 1' // Reset timestamps for better seeking
      ])
      .on('start', () => {
        console.log(`Started recording: ${streamKey}`);
      })
      .on('error', (err) => {
        console.error(`Recording error for ${streamKey}:`, err);
        this.stopRecording(streamKey);
      })
      .on('end', () => {
        console.log(`Recording finished: ${streamKey}`);
        this.recordings.delete(streamKey);
        
        // Generate thumbnail after recording ends
        this.generateThumbnail(outputPath, recordingId, streamKey);
      })
      .save(outputPath);

    // Store recording info
    this.recordings.set(streamKey, {
      id: recordingId,
      streamKey,
      userId,
      filename,
      path: outputPath,
      startTime: new Date(),
      command
    });

    return true;
  }

  // Stop recording a stream
  stopRecording(streamKey) {
    const recording = this.recordings.get(streamKey);
    if (!recording) return false;

    recording.command.ffmpegProc.stdin.write('q');
    this.recordings.delete(streamKey);
    
    console.log(`Stopped recording: ${streamKey}`);
    return true;
  }

  // Generate a thumbnail from the recording
  async generateThumbnail(videoPath, recordingId, streamKey) {
    const thumbnailPath = path.join(
      __dirname, 
      `../recordings/thumbnails/${recordingId}.jpg`
    );

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: ['10%'], // Take a thumbnail at 10% of the video
          filename: `${recordingId}.jpg`,
          folder: path.dirname(thumbnailPath),
          size: '640x360'
        })
        .on('end', () => {
          console.log(`Generated thumbnail for recording: ${recordingId}`);
          resolve(thumbnailPath);
        })
        .on('error', (err) => {
          console.error('Thumbnail generation error:', err);
          reject(err);
        });
    });
  }

  // Get recording info by stream key
  getRecordingInfo(streamKey) {
    return this.recordings.get(streamKey) || null;
  }

  // Get all active recordings
  getActiveRecordings() {
    return Array.from(this.recordings.values());
  }

  // Clean up old recordings (to be called periodically)
  cleanupOldRecordings(maxAgeDays = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    
    const recordingsDir = path.join(__dirname, '../recordings/videos');
    
    fs.readdir(recordingsDir, (err, files) => {
      if (err) {
        console.error('Error reading recordings directory:', err);
        return;
      }
      
      files.forEach(file => {
        const filePath = path.join(recordingsDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.birthtime < cutoffDate) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Error deleting old recording ${file}:`, err);
            } else {
              console.log(`Deleted old recording: ${file}`);
              
              // Delete corresponding thumbnail if exists
              const thumbnailPath = path.join(
                __dirname, 
                `../recordings/thumbnails/${path.parse(file).name}.jpg`
              );
              
              if (fs.existsSync(thumbnailPath)) {
                fs.unlink(thumbnailPath, (err) => {
                  if (err) console.error(`Error deleting thumbnail for ${file}:`, err);
                });
              }
            }
          });
        }
      });
    });
  }
}

// Create a singleton instance
const recordingService = new RecordingService();

// Schedule cleanup of old recordings (run once per day)
setInterval(() => {
  recordingService.cleanupOldRecordings();
}, 24 * 60 * 60 * 1000);

module.exports = recordingService;
