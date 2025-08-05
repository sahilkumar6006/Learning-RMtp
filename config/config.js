require('dotenv').config();

module.exports = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: process.env.PORT || 8000,
    mediaroot: './media',
    allow_origin: '*'
  },
  trans: {
    ffmpeg: 'C:/ffmpeg/bin/ffmpeg.exe', // Update this path to your FFmpeg installation
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
        dash: true,
        dashFlags: '[f=dash:window_size=3:extra_window_size=1]'
      }
    ]
  },
  auth: {
    api: true,
    api_user: 'admin',
    api_pass: process.env.API_PASSWORD || 'change_this_password',
    play: false,
    publish: false,
    secret: process.env.SECRET_KEY || 'your_jwt_secret_key'
  }
};
