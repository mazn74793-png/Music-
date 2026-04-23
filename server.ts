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

      // Hardened initialization with common browser headers
      youtube = await Innertube.create({
        cache: new UniversalCache(false),
        generate_visitor_id: true,
      });

      // Manually set some context to avoid bot detection
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
      
      if (youtube.session.context) {
        youtube.session.context.client.userAgent = userAgent;
        youtube.session.context.client.clientName = 'WEB';
        youtube.session.context.client.clientVersion = '2.20240124.01.00';
      }

      if (ytCredentials) {
        try {
          await youtube.session.signIn(ytCredentials);
          console.log('[YT-AUTH] Signed in successfully from saved session');
        } catch (signInErr) {
          console.error('[YT-AUTH] Session sign-in failed, continuing as guest:', signInErr);
        }
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
      signedIn: youtube?.session?.logged_in || false,
      hasApiKey: !!process.env.YOUTUBE_API_KEY
    });
  });

  // Store user-provided API key for Tier 3 search
  app.post('/api/settings/api-key', (req, res) => {
    const { key } = req.body;
    if (key) {
      process.env.YOUTUBE_API_KEY = key;
      console.log('[SETTINGS] YouTube API Key set manually');
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Key is required' });
    }
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
    if (!query) return res.json([]);

    try {
      if (!youtube) await initYoutube();
      
      let songs: any[] = [];
      let lastError = '';
      
      const performSearch = async () => {
        // --- TIER 1: YouTube Music Search ---
        try {
          console.log(`[SEARCH] Tier 1: YTM Search for "${query}"`);
          const results = await youtube.music.search(query, { type: 'song' });
          return results.contents?.flatMap((c: any) => c.contents || [])
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
        } catch (musicErr: any) {
          console.warn('[SEARCH] Tier 1 failed:', musicErr.message);
          
          if (musicErr.message.includes('400')) {
             console.log('[SEARCH] Self-healing: 400 detected, re-init Innertube...');
             await initYoutube();
          }

          // --- TIER 2: YouTube Core Search ---
          try {
            console.log(`[SEARCH] Tier 2: Core Search for "${query}"`);
            const generalResults = await youtube.search(query, { type: 'video' });
            return generalResults.videos?.map((video: any) => ({
              id: video.id,
              title: video.title?.toString() || 'Unknown Title',
              artist: video.author?.name || 'Unknown Artist',
              thumbnail: video.thumbnails?.[0]?.url,
              duration: video.duration?.seconds || 0,
              durationText: video.duration?.label || '',
              album: 'YouTube'
            })) || [];
          } catch (coreErr: any) {
             console.warn('[SEARCH] Tier 2 failed:', coreErr.message);
             throw coreErr;
          }
        }
      };

      try {
        songs = await performSearch();
      } catch (e: any) {
        lastError = e.message;
      }

      if (songs && songs.length > 0) return res.json(songs);

      // --- TIER 3: YouTube Data API v3 (Ultimate Fallback) ---
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        try {
          console.log(`[SEARCH] Tier 3: Data API v3 for "${query}"`);
          const apiRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
              part: 'snippet',
              q: query,
              maxResults: 20,
              type: 'video',
              key: apiKey,
              videoCategoryId: '10' // Music category
            }
          });

          songs = apiRes.data.items.map((item: any) => ({
            id: item.id.videoId,
            title: item.snippet.title,
            artist: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
            duration: 0,
            durationText: '--:--',
            album: 'API Fallback'
          }));

          if (songs.length > 0) return res.json(songs);
        } catch (apiErr: any) {
          console.error('[SEARCH] Tier 3 failed (API Key):', apiErr.message);
        }
      }

      throw new Error(`Search unavailable. Last error: ${lastError}`);
    } catch (error: any) {
      console.error('Final Search Fatal:', error.message);
      res.status(500).json({ error: error.message });
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

      // Strategy 1: InnerTube (Resilient Fallback & Authenticated)
      if (!youtube) await initYoutube();
      
      const clients: any[] = ['TV_EMBEDDED', 'WEB', 'ANDROID_TESTSUITE', 'ANDROID_MUSIC', 'IOS', 'YTMUSIC'];
      let lastError = '';
      let retryCount = 0;

      const attemptStream = async () => {
        for (const client of clients) {
          try {
            console.log(`[STREAM] Strategy: Client=${client} for ${videoId}`);
            
            // Add a small artificial delay to avoid rapid-fire blocks
            await new Promise(r => setTimeout(r, 150));

            // Use specific method for Music clients
            let info;
            try {
              if (client.includes('MUSIC')) {
                info = await youtube.music.getInfo(videoId);
              } else {
                info = await youtube.getInfo(videoId, client);
              }
            } catch (fetchErr: any) {
              if (fetchErr.message.includes('400')) {
                console.warn(`[STREAM] Client ${client} returned 400.`);
                if (retryCount === 0) {
                   console.log('[STREAM] Self-healing: 400 detected, refreshing session...');
                   await initYoutube();
                   retryCount++;
                   return 'retry'; 
                }
                continue; 
              }
              throw fetchErr;
            }
            
            if (info.playability_status?.status === 'OK') {
              const stream = await info.download({ type: 'audio', quality: 'best' });
              res.setHeader('Content-Type', 'audio/mpeg');
              const reader = stream.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
              res.end();
              return 'done';
            } else {
              lastError = info.playability_status?.reason || info.playability_status?.status || 'Error';
              console.warn(`[STREAM] Client ${client} failed: ${lastError}`);
            }
          } catch (e: any) {
            lastError = e.message;
            console.warn(`[STREAM] Client ${client} error: ${e.message}`);
          }
        }
        return 'failed';
      };

      let result = await attemptStream();
      if (result === 'retry') result = await attemptStream();
      if (result === 'done') return;

      // Strategy 2: ytdl-core (Last Resort)
      try {
        console.log(`[STREAM] Last resort: ytdl-core for ${videoId}`);
        const stream = ytdl(videoId, { 
          filter: 'audioonly', 
          quality: 'highestaudio',
          requestOptions: {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            }
          }
        });
        
        // Wait for first data or error to avoid broken headers
        await new Promise((resolve, reject) => {
          stream.once('info', resolve);
          stream.once('error', reject);
          setTimeout(() => reject(new Error('ytdl timeout')), 5000);
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        stream.pipe(res);
        return;
      } catch (e: any) {
        console.warn('[STREAM] ytdl-core absolutely failed:', e.message);
        lastError = e.message;
      }

      throw new Error(`All streaming engines were blocked. ${lastError === 'Sign in to confirm you’re not a bot' ? 'YouTube is requesting account verification. Please go to Connectivity and link your account.' : lastError}`);

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
