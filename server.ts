import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { Innertube, UniversalCache } from 'youtubei.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  let youtube: Innertube;
  async function initYoutube() {
    try {
      youtube = await Innertube.create({
        cache: new UniversalCache(false),
        // Use a more generic user agent or session store if possible
      });
      console.log('Innertube initialized successfully');
    } catch (err) {
      console.error('Failed to initialize Innertube initially', err);
    }
  }
  
  await initYoutube();

  app.use(cors());
  app.use(express.json());

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
      if (!youtube) await initYoutube();

      let info = null;
      let format = null;
      let lastError = '';

      // Strategic ordering of clients based on known bypass success
      // TV_EMBEDDED is currently one of the most reliable for bypassing blocks
      const clients: any[] = ['TV_EMBEDDED', 'ANDROID_MUSIC', 'ANDROID', 'YTMUSIC', 'MWEB', 'WEB', 'IOS'];

      for (const client of clients) {
        try {
          console.log(`[STREAM] Trying client: ${client} for ${videoId}`);
          
          let currentInfo;
          if (client === 'YTMUSIC') {
            currentInfo = await youtube.music.getInfo(videoId);
          } else {
            currentInfo = await youtube.getInfo(videoId, client);
          }

          const status = currentInfo.playability_status?.status;
          if (status === 'UNPLAYABLE' || status === 'LOGIN_REQUIRED') {
            lastError = currentInfo.playability_status?.reason || status || 'Unknown block';
            console.warn(`[STREAM] Client ${client} blocked: ${lastError}`);
            continue;
          }

          const currentFormat = currentInfo.chooseFormat({ 
            type: 'audio', 
            quality: 'best', 
            format: 'any' 
          });

          if (currentFormat && currentFormat.url) {
            info = currentInfo;
            format = currentFormat;
            console.log(`[STREAM] SUCCESS with client ${client}.`);
            break;
          }
        } catch (e: any) {
          lastError = e.message;
          console.warn(`[STREAM] Strategy ${client} failed: ${e.message}`);
          await new Promise(r => setTimeout(r, 100));
        }
      }

      if (!info || !format) {
        throw new Error(`YouTube is strictly blocking this video for server streaming. Reason: ${lastError}. Please try the "Audio" or "Lyric" version.`);
      }

      console.log(`[STREAM] FINAL SUCCESS. Format=${format.mime_type}`);

      // Optimized streaming with better error handling and piping logic
      try {
        const stream = await info.download({
          type: 'audio',
          quality: 'best'
        });

        res.setHeader('Content-Type', format.mime_type || 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Transfer-Encoding', 'chunked');
        
        const reader = stream.getReader();
        
        req.on('close', () => {
          reader.cancel().catch(() => {});
        });

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          if (res.writable) {
            res.write(value);
          } else {
            reader.cancel().catch(() => {});
            break;
          }
        }
      } catch (downloadErr: any) {
        console.error('[STREAM] Download stream failed, attempting direct URL proxy fallback...');
        if (format.url && !res.headersSent) {
          res.setHeader('Content-Type', format.mime_type || 'audio/mpeg');
          const response = await axios.get(format.url, {
            responseType: 'stream',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
          });
          response.data.pipe(res);
        } else {
          throw downloadErr;
        }
      }

    } catch (error: any) {
      console.error(`[STREAM] FATAL error for ${videoId}:`, error.message);
      res.status(500).json({ error: error.message });
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
