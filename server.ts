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
import yts from 'yt-search';
import play from 'play-dl';
import youtubeSearch from 'youtube-search-api';
import { google } from 'googleapis';

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
      // Load session
      try {
        const data = await fs.readFile(SESSION_FILE, 'utf-8');
        ytCredentials = JSON.parse(data);
        console.log('[YT-AUTH] Session loaded');
      } catch (e) {
        console.log('[YT-AUTH] No session file found');
        ytCredentials = null;
      }

      // Initialize with standard parameters. 
      // Manual context overriding often triggers 400 errors in recent Innertube versions.
      youtube = await Innertube.create({
        generate_visitor_id: true
      });

      if (ytCredentials) {
        try {
          await youtube.session.signIn(ytCredentials);
          console.log('[YT-AUTH] Sign-in successful');
        } catch (e) {
          console.error('[YT-AUTH] Sign-in failed (session might be expired):', e);
          await fs.unlink(SESSION_FILE).catch(() => {});
        }
      }

      console.log('[SERVER] Innertube setup complete');
    } catch (err) {
      console.error('[SERVER] Critical Innertube error:', err);
    }
  }

  await initYoutube();

  app.use(cors());
  app.use(express.json());

  // --- Search (High Reliability) ---
  app.get('/api/search/music', async (req, res) => {
    const query = req.query.q as string;
    if (!query) return res.json([]);
    
    try {
      console.log(`[SEARCH] Query: "${query}"`);
      
      const apiKey = process.env.YOUTUBE_API_KEY;

      // Tier 0: Official YouTube Data API (Highest reliability if key exists)
      if (apiKey) {
        try {
          console.log('[SEARCH] Attempting Official API');
          const yt = google.youtube({ version: 'v3', auth: apiKey });
          const response = await yt.search.list({
            part: ['snippet'],
            q: query,
            maxResults: 20,
            type: ['video'],
            videoCategoryId: '10' // Music
          });

          if (response.data.items && response.data.items.length > 0) {
            const results = response.data.items.map((item: any) => ({
              id: item.id.videoId,
              title: item.snippet.title,
              artist: item.snippet.channelTitle,
              thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
              duration: 0,
              durationText: '--:--',
              album: 'Official Search'
            }));
            return res.json(results);
          }
        } catch (e: any) {
          console.warn('[SEARCH] Official API Tier failed:', e.message);
        }
      }

      // Tier 1: yt-search
        const r = await yts(query);
        const videos = r.videos.slice(0, 20);
        if (videos.length > 0) {
          const results = videos.map(v => ({
            id: v.videoId,
            title: v.title,
            artist: v.author.name,
            thumbnail: v.thumbnail || v.image,
            duration: v.seconds,
            durationText: v.timestamp,
            album: 'Search Result'
          }));
          return res.json(results);
        }
      } catch (e) {
        console.warn('[SEARCH] Tier 1 failed:', e);
      }

      // Tier 2: youtube-search-api (Very robust)
      try {
        const data = await youtubeSearch.GetListByKeyword(query, false, 20);
        if (data && data.items && data.items.length > 0) {
          const results = data.items.map((v: any) => ({
            id: v.id,
            title: v.title,
            artist: v.channelTitle || 'Unknown',
            thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            duration: 0,
            durationText: v.length?.simpleText || '--:--',
            album: 'Search Result'
          }));
          return res.json(results);
        }
      } catch (e) {
        console.warn('[SEARCH] Tier 2 failed:', e);
      }

      res.json([]);
    } catch (error: any) {
      console.error('[SEARCH] Fatal Failure:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Store user-provided API key for Tier 3 search fallback
  app.post('/api/settings/api-key', (req, res) => {
    const { key } = req.body;
    if (key) {
      process.env.YOUTUBE_API_KEY = key;
      console.log('[SETTINGS] Custom YouTube API Key saved');
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Key is required' });
    }
  });

  // --- YouTube Auth Routes ---
  app.get('/api/yt/auth/status', (req, res) => {
    res.json({ 
      signedIn: youtube?.session?.logged_in || false,
      user: youtube?.session?.info || null
    });
  });

  let authPendingData: any = null;

  app.get('/api/yt/auth/start', async (req, res) => {
    try {
      if (!youtube) await initYoutube();
      
      // If we already have a pending code, return it
      if (authPendingData) {
        return res.json(authPendingData);
      }

      const codePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          authPendingData = null;
          reject(new Error('Auth timed out'));
        }, 120000);
        
        youtube.session.once('auth-pending', (data) => {
          clearTimeout(timeout);
          authPendingData = data;
          console.log('[AUTH] Auth code generated:', data.user_code);
          resolve(data);
        });

        // Start the sign in flow
        youtube.session.signIn().catch(err => {
          if (!err.message.includes('auth-pending')) {
            console.error('[AUTH] SignIn error:', err.message);
            reject(err);
          }
        });
      });

      youtube.session.once('auth', async (data) => {
        authPendingData = null;
        await fs.writeFile(SESSION_FILE, JSON.stringify(data.credentials), 'utf-8');
        console.log('[AUTH] Token saved successfully');
        await initYoutube();
      });

      const authInfo = await codePromise;
      res.json(authInfo);
    } catch (err: any) {
      authPendingData = null;
      console.error('[AUTH] Start failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/yt/auth/logout', async (req, res) => {
    try {
      await fs.unlink(SESSION_FILE).catch(() => {});
      await initYoutube();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: 'Logout failed: ' + e.message });
    }
  });

  // --- Streaming (Multi-Engine Reliable Stream) ---
  app.get('/api/stream/:videoId', async (req, res) => {
    const { videoId } = req.params;
    console.log(`[STREAM] Audio ID: ${videoId}`);

    try {
      // TIER 1: play-dl (Uses fresh tokens and robust internal proxying for signatures)
      try {
        console.log(`[STREAM] Attempting play-dl for ${videoId}`);
        const stream = await play.stream(videoId);
        
        if (stream && stream.stream) {
          console.log('[STREAM] play-dl Success!');
          // Set appropriate headers for the type of stream (usually webm/opus)
          res.setHeader('Content-Type', stream.type || 'audio/mpeg');
          stream.stream.pipe(res);
          return;
        }
      } catch (e: any) {
        console.warn('[STREAM] play-dl failed:', e.message);
      }

      // TIER 2: ytdl-core (Backup)
      try {
        console.log(`[STREAM] Attempting ytdl-core for ${videoId}`);
        const info = await ytdl.getInfo(videoId);
        const format = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' });
        
        if (format && format.url) {
          const response = await axios.get(format.url, {
            responseType: 'stream',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Range': 'bytes=0-'
            }
          });
          res.setHeader('Content-Type', 'audio/mpeg');
          response.data.pipe(res);
          return;
        }
      } catch (e: any) {
        console.warn('[STREAM] ytdl-core failed:', e.message);
      }

      // TIER 3: Innertube fallback
      if (youtube) {
        try {
          console.log(`[STREAM] Attempting Innertube Fallback for ${videoId}`);
          const info = await youtube.getInfo(videoId, 'TV');
          const format = info.chooseFormat({ type: 'audio', quality: 'best' });
          if (format && format.url) {
            const response = await axios.get(format.url, { responseType: 'stream' });
            res.setHeader('Content-Type', 'audio/mpeg');
            response.data.pipe(res);
            return;
          }
        } catch (e: any) {
          console.warn('[STREAM] Innertube fallback failed:', e.message);
        }
      }

      throw new Error('All streaming engines exhausted');
      
    } catch (error: any) {
      console.error('[STREAM] FATAL:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // Serve Frontend
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running at http://localhost:${PORT}`);
  });
}

startServer();
