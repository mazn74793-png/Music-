import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { Innertube, UniversalCache } from 'youtubei.js';
import axios from 'axios';
import ytdl from '@distube/ytdl-core';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_FILE = path.join(__dirname, 'yt-session.json');

async function startServer() {
  const app = express();
  const PORT = 3000;

  let youtube: Innertube;
  let ytCredentials: any = null;

  async function initYoutube() {
    try {
      // Try to load saved session
      try {
        const data = await fs.readFile(SESSION_FILE, 'utf-8');
        ytCredentials = JSON.parse(data);
        console.log('[YT-AUTH] Found saved session');
      } catch (e) {
        console.log('[YT-AUTH] No saved session found, running as guest');
      }

      youtube = await Innertube.create({
        cache: new UniversalCache(false),
      });

      if (ytCredentials) {
        await youtube.session.signIn(ytCredentials);
        console.log('[YT-AUTH] Signed in successfully from saved session');
      }

      console.log('Innertube initialized successfully');
    } catch (err) {
      console.error('Failed to initialize Innertube', err);
    }
  }
  
  // Initialize YouTube in background to not block server start
  initYoutube().then(() => {
    console.log('[SERVER] YouTube initialized (Background)');
  }).catch(err => {
    console.error('[SERVER] Background YouTube init failure:', err);
  });

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      youtubeInit: !!youtube,
      signedIn: youtube?.session?.logged_in || false 
    });
  });

  // --- YouTube Session Management (OuterTune Style) ---
  
  let currentAuthRequest: any = null;

  app.get('/api/yt/auth/status', (req, res) => {
    res.json({
      signedIn: youtube?.session?.logged_in || false,
      user: youtube?.session?.logged_in ? {
        name: 'Connected Account', // YouTubei.js doesn't expose full name easily without specific calls
        status: 'Active'
      } : null
    });
  });

  app.get('/api/yt/auth/start', async (req, res) => {
    if (!youtube) await initYoutube();
    
    try {
      // Capture the auth-pending event to send to the client
      const codePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Auth timeout')), 30000);
        
        youtube.session.on('auth-pending', (data) => {
          clearTimeout(timeout);
          currentAuthRequest = data;
          resolve(data);
        });
      });

      // Start sign in
      youtube.session.signIn().catch(err => {
        console.error('[YT-AUTH] SignIn error:', err.message);
      });

      // Handle successful auth in background
      youtube.session.on('auth', async (data) => {
        console.log('[YT-AUTH] Authentication successful!');
        await fs.writeFile(SESSION_FILE, JSON.stringify(data.credentials), 'utf-8');
      });

      const authData = await codePromise;
      res.json(authData);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/yt/auth/logout', async (req, res) => {
    try {
      await fs.unlink(SESSION_FILE);
      await initYoutube(); // Re-init as guest
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to logout' });
    }
  });

  // --- End Auth Routes ---

  // YouTube Music search (OuterTune style)
  app.get('/api/search/music', async (req, res) => {
    const query = req.query.q as string;
    try {
      if (!youtube) await initYoutube();
      const results = await youtube.music.search(query, { type: 'song' });
      
      // Transform YTM results to a simpler format
      const songs = results.contents?.flatMap((c: any) => c.contents || [])
        .filter((item: any) => item.type === 'MusicResponsiveListItem' || item.type === 'Song')
        .map((item: any) => ({
          id: item.id,
          title: item.title,
          artist: item.artists?.map((a: any) => a.name).join(', ') || item.author?.name || 'Unknown',
          thumbnail: item.thumbnail?.contents?.[0]?.url || item.thumbnails?.[0]?.url,
          duration: item.duration?.seconds || 0,
          durationText: item.duration?.text || '',
          album: item.album?.name || ''
        })) || [];

      res.json(songs);
    } catch (error: any) {
      console.error('Music search error:', error.message);
      res.status(500).json({ error: 'Failed to search YouTube Music' });
    }
  });

  // Download/Stream audio
  app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
      console.log(`[STREAM] Processing: ${videoId}`);

      // Strategy 0: Authenticated Bypass (The OuterTune Way)
      if (youtube?.session?.logged_in) {
        try {
          console.log(`[STREAM] Using AUTH session for ${videoId}`);
          const info = await youtube.getInfo(videoId, 'ANDROID_MUSIC' as any);
          const stream = await info.download({ type: 'audio', quality: 'best' });
          res.setHeader('Content-Type', 'audio/mpeg');
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
          return;
        } catch (authErr: any) {
          console.warn('[STREAM] Auth stream failed:', authErr.message);
        }
      }

      // Strategy 1: ytdl-core
      try {
        const stream = ytdl(videoId, { filter: 'audioonly', quality: 'highestaudio' });
        res.setHeader('Content-Type', 'audio/mpeg');
        stream.pipe(res);
        return;
      } catch (e) {
        console.warn('ytdl fail');
      }

      // Strategy 2: InnerTube Fallback
      if (!youtube) await initYoutube();
      const clients: any[] = ['TV_EMBEDDED', 'ANDROID_TESTSUITE', 'ANDROID_MUSIC'];
      let lastError = '';

      for (const client of clients) {
        try {
          console.log(`[STREAM] Strategy: Client=${client} for ${videoId}`);
          const info = await youtube.getInfo(videoId, client);
          
          if (info.playability_status?.status === 'OK') {
            const format = info.chooseFormat({ type: 'audio', quality: 'best' });
            if (format && format.url) {
              const stream = await info.download({ type: 'audio', quality: 'best' });
              res.setHeader('Content-Type', 'audio/mpeg');
              const reader = stream.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
              res.end();
              return;
            }
          } else {
            lastError = info.playability_status?.reason || info.playability_status?.status || 'Error';
          }
        } catch (e: any) {
          lastError = e.message;
        }
      }

      throw new Error(`All engines blocked: ${lastError}`);

    } catch (error: any) {
      console.error(`[STREAM] FATAL for ${videoId}:`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      } else {
        res.end();
      }
    }
  });

  // Get info for a video (metadata) using YouTube Data API v3 for speed and reliability
  app.get('/api/info/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'YOUTUBE_API_KEY not configured' });
    }

    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: {
          part: 'snippet,contentDetails',
          id: videoId,
          key: apiKey
        }
      });

      const video = response.data.items[0];
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }

      // Convert ISO 8601 duration (PT4M20S) to seconds
      const durationStr = video.contentDetails.duration;
      let durationSeconds = 0;
      const hours = durationStr.match(/(\d+)H/);
      const minutes = durationStr.match(/(\d+)M/);
      const seconds = durationStr.match(/(\d+)S/);
      if (hours) durationSeconds += parseInt(hours[1]) * 3600;
      if (minutes) durationSeconds += parseInt(minutes[1]) * 60;
      if (seconds) durationSeconds += parseInt(seconds[1]);

      res.json({
        id: videoId,
        title: video.snippet.title,
        artist: video.snippet.channelTitle,
        thumbnail: video.snippet.thumbnails.maxres?.url || video.snippet.thumbnails.high?.url || video.snippet.thumbnails.default.url,
        duration: durationSeconds,
      });
    } catch (error: any) {
      console.error('Info error:', error?.response?.data || error.message);
      res.status(500).json({ error: 'Failed to get video info' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
