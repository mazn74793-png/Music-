/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, Search as SearchIcon, 
  Library as LibraryIcon, Download, DownloadCloud, Trash2, 
  Plus, Heart, Menu, X, ChevronDown, Music, WifiOff, Upload,
  Monitor, ExternalLink, ShieldCheck, RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Song, getAllSongs, saveSong, deleteSong } from './db';
import axios from 'axios';
import { User } from 'firebase/auth';
import { loginWithGoogle, logout, subscribeToAuth, toggleFavorite, getFavorites, FavoriteSong } from './firebase';

// --- Components ---

type View = 'library' | 'search' | 'local' | 'favorites' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('library');
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [library, setLibrary] = useState<Song[]>([]);
  const [favorites, setFavorites] = useState<FavoriteSong[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [ytStatus, setYtStatus] = useState<{ signedIn: boolean; user: any }>({ signedIn: false, user: null });
  const [ytAuthData, setYtAuthData] = useState<any>(null);
  const [isConnectingYt, setIsConnectingYt] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackStatus, setPlaybackStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [userApiKey, setUserApiKey] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackIdRef = useRef<number>(0);

  // Load library on mount
  useEffect(() => {
    refreshLibrary();
    checkYtStatus();
    const unsubscribe = subscribeToAuth((u) => {
      setUser(u);
      if (u) {
        refreshFavorites(u.uid);
      } else {
        setFavorites([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const refreshLibrary = async () => {
    const songs = await getAllSongs();
    setLibrary(songs.sort((a, b) => b.dateAdded - a.dateAdded));
  };

  const refreshFavorites = async (userId: string) => {
    const favs = await getFavorites(userId);
    setFavorites(favs as FavoriteSong[]);
  };

  const checkYtStatus = async () => {
    try {
      const res = await axios.get('/api/yt/auth/status');
      setYtStatus(res.data);
    } catch (e) {
      console.error('Failed to check YT status');
    }
  };

  const startYtConnect = async () => {
    setIsConnectingYt(true);
    try {
      const res = await axios.get('/api/yt/auth/start');
      setYtAuthData(res.data);
      
      // Start polling for completion
      const interval = setInterval(async () => {
        const statusRes = await axios.get('/api/yt/auth/status');
        if (statusRes.data.signedIn) {
          setYtStatus(statusRes.data);
          setYtAuthData(null);
          setIsConnectingYt(false);
          clearInterval(interval);
        }
      }, 5000);

      // Cleanup polling after 5 mins
      setTimeout(() => clearInterval(interval), 300000);

    } catch (e) {
      console.error('Failed to start YT auth');
      setIsConnectingYt(false);
    }
  };

  const logoutYt = async () => {
    try {
      await axios.post('/api/yt/auth/logout');
      checkYtStatus();
    } catch (e) {
      console.error('Failed to logout from YT');
    }
  };

  const handleFavorite = async (song: any) => {
    if (!user) {
      alert('Please login to save favorites');
      return;
    }
    await toggleFavorite(user.uid, song);
    refreshFavorites(user.uid);
  };

  const [objectUrls, setObjectUrls] = useState<Set<string>>(new Set());

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      objectUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [objectUrls]);

  const playSong = async (song: Song) => {
    if (currentSong?.id === song.id) {
      togglePlay();
      return;
    }

    // Stop current cleanly
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = ""; // Clear source to stop any pending load
      audioRef.current.load();
    }

    setCurrentSong(song);
    setIsPlaying(false);
    setPlaybackStatus('loading');
    setErrorMessage('');
    setProgress(0);
    setDuration(song.duration || 0);

    const sourceUrl = song.audioBlob 
      ? URL.createObjectURL(song.audioBlob) 
      : `/api/stream/${song.id}`;

    if (song.audioBlob) {
      setObjectUrls(prev => new Set(prev).add(sourceUrl));
    }

    if (audioRef.current) {
      audioRef.current.src = sourceUrl;
      
      try {
        audioRef.current.load(); 
        const playPromise = audioRef.current.play();
        
        if (playPromise !== undefined) {
          await playPromise;
          setIsPlaying(true);
          setPlaybackStatus('playing');
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('Playback failed', err);
          setPlaybackStatus('error');
          setErrorMessage(err.message || 'Failed to play this song.');
        }
      }
    }
  };

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setView('search');
    try {
      const res = await axios.get(`/api/search/music?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(res.data);
    } catch (err) {
      console.error('Search failed', err);
      setSearchResults([]);
      setErrorMessage('Search failed. If you are on Vercel, YouTube might be blocking the server IP. Try linking your account or adding a YouTube API Key in "Connect".');
      setView('settings');
    } finally {
      setIsSearching(false);
    }
  };

  const downloadSong = async (id: string, title: string, artist: string, thumbnail: string, duration: number) => {
    if (downloadingIds.has(id)) return;
    
    setDownloadingIds(prev => new Set(prev).add(id));
    try {
      const response = await axios.get(`/api/stream/${id}`, { responseType: 'blob' });
      const song: Song = {
        id,
        title,
        artist,
        thumbnail,
        duration,
        audioBlob: response.data,
        type: 'offline',
        dateAdded: Date.now()
      };
      await saveSong(song);
      await refreshLibrary();
    } catch (err) {
      console.error('Download failed', err);
      alert('Download failed');
    } finally {
      setDownloadingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleLocalFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files) as File[]) {
      if (!file.type.startsWith('audio/')) continue;

      const song: Song = {
        id: `local-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        title: file.name.replace(/\.[^/.]+$/, ""),
        artist: 'Local File',
        thumbnail: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=2670&auto=format&fit=crop',
        duration: 0,
        audioBlob: file as Blob,
        type: 'local',
        dateAdded: Date.now()
      };
      await saveSong(song);
    }
    refreshLibrary();
    setView('library');
  };

  const removeSong = async (id: string) => {
    if (confirm('Remove this song from offline library?')) {
      await deleteSong(id);
      await refreshLibrary();
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const playNext = () => {
    const list = view === 'library' ? library : searchResults;
    const currentIndex = list.findIndex(s => s.id === currentSong?.id);
    if (currentIndex !== -1 && currentIndex < list.length - 1) {
      playSong(list[currentIndex + 1]);
    }
  };

  const playPrevious = () => {
    const list = view === 'library' ? library : searchResults;
    const currentIndex = list.findIndex(s => s.id === currentSong?.id);
    if (currentIndex > 0) {
      playSong(list[currentIndex - 1]);
    }
  };

  const seek = (e: React.MouseEvent | React.TouchEvent, totalDuration: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    let clientX = 0;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
    } else {
      clientX = (e as React.MouseEvent).clientX;
    }
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    if (audioRef.current) audioRef.current.currentTime = pct * totalDuration;
  };

  return (
    <div className="flex flex-col h-screen bg-[#050505] text-white font-sans selection:bg-cyan-500 selection:text-black">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-600/5 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-blue-600/5 blur-[120px]" />
      </div>

      <audio 
        ref={audioRef} 
        onTimeUpdate={() => setProgress(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={() => setIsPlaying(false)}
        onError={async () => {
          setPlaybackStatus('error');
          setIsPlaying(false);
          try {
            // Try to get error message from server if it failed to serve the audio
            const res = await axios.get(audioRef.current?.src || '');
            if (res.data && res.data.error) {
              setErrorMessage(res.data.error);
            }
          } catch (e: any) {
            setErrorMessage('Playback failed. This usually means YouTube is blocking temporary guest sessions. Try linking your account in Connectivity.');
          }
        }}
      />

      {/* Main Container */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden relative z-10">
        {/* Sidebar (Desktop) */}
        <nav className="hidden md:flex flex-col w-64 bg-black border-r border-zinc-800 p-8 gap-12">
          <div className="text-2xl font-bold tracking-tighter flex items-center gap-2">
            <div className="w-8 h-8 bg-cyan-500 rounded-full flex items-center justify-center">
              <div className="w-3 h-3 bg-black rounded-sm rotate-45"></div>
            </div>
            MyStreamer
          </div>
          
          <div className="space-y-8">
            <div className="space-y-4">
              <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Browse</p>
              <button 
                onClick={() => setView('library')}
                className={`flex items-center gap-3 font-medium transition-colors ${view === 'library' ? 'text-cyan-400' : 'text-zinc-400 hover:text-white'}`}
              >
                <LibraryIcon className="w-5 h-5" />
                Library
              </button>
              <button 
                onClick={() => setView('favorites')}
                className={`flex items-center gap-3 font-medium transition-colors ${view === 'favorites' ? 'text-cyan-400' : 'text-zinc-400 hover:text-white'}`}
              >
                <Heart className="w-5 h-5" />
                Favorites
              </button>
              <button 
                onClick={() => setView('search')}
                className={`flex items-center gap-3 transition-colors ${view === 'search' ? 'text-cyan-400 font-medium' : 'text-zinc-400 hover:text-white'}`}
              >
                <SearchIcon className="w-5 h-5" />
                Search
              </button>
              <button 
                onClick={() => setView('settings')}
                className={`flex items-center gap-3 transition-colors ${view === 'settings' ? 'text-cyan-400 font-medium' : 'text-zinc-400 hover:text-white'}`}
              >
                <Monitor className="w-5 h-5" />
                Connectivity
              </button>
            </div>

            <div className="space-y-4">
              <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Premium</p>
              <label className="flex items-center gap-3 text-zinc-400 hover:text-white cursor-pointer transition-colors">
                <Upload className="w-5 h-5" />
                Import Local
                <input type="file" multiple accept="audio/*" className="hidden" onChange={handleLocalFile} />
              </label>
            </div>
          </div>

          <div className="mt-auto space-y-4">
            {user ? (
              <div className="flex items-center gap-3 p-2 rounded-xl bg-zinc-900 border border-zinc-800">
                <img src={user.photoURL || ''} className="w-8 h-8 rounded-full" alt="" />
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-bold truncate">{user.displayName}</p>
                  <button onClick={logout} className="text-[10px] text-zinc-500 hover:text-white">Logout</button>
                </div>
              </div>
            ) : (
              <button 
                onClick={loginWithGoogle}
                className="w-full flex items-center justify-center gap-2 py-3 bg-white text-black rounded-xl font-bold hover:bg-zinc-200 transition-all"
              >
                Login with Google
              </button>
            )}
            <div className="p-4 rounded-2xl bg-zinc-900 border border-zinc-800 text-sm">
              <div className="flex justify-between items-center mb-2">
                <span className="text-zinc-500">Storage</span>
                <span className="text-cyan-400">Low</span>
              </div>
              <div className="w-full bg-zinc-800 h-1 rounded-full">
                <div className="bg-cyan-500 h-1 rounded-full w-[20%]"></div>
              </div>
            </div>
          </div>
        </nav>

        {/* Mobile Nav Overlay (Bottom Bar) */}
        <nav className="md:hidden flex bg-zinc-950/80 backdrop-blur-lg border-t border-zinc-800 fixed bottom-0 left-0 right-0 z-50 px-2 py-3 justify-around items-center h-20">
          <button onClick={() => setView('library')} className={`flex flex-col items-center gap-1 flex-1 ${view === 'library' ? 'text-cyan-400' : 'text-zinc-500'}`}>
            <LibraryIcon className="w-6 h-6" />
            <span className="text-[10px] uppercase font-bold tracking-widest">Library</span>
          </button>
          <button onClick={() => setView('search')} className={`flex flex-col items-center gap-1 flex-1 ${view === 'search' ? 'text-cyan-400' : 'text-zinc-500'}`}>
            <SearchIcon className="w-6 h-6" />
            <span className="text-[10px] uppercase font-bold tracking-widest">Search</span>
          </button>
          <button onClick={() => setView('favorites')} className={`flex flex-col items-center gap-1 flex-1 ${view === 'favorites' ? 'text-cyan-400' : 'text-zinc-500'}`}>
            <Heart className="w-6 h-6" />
            <span className="text-[10px] uppercase font-bold tracking-widest">Favs</span>
          </button>
          <button onClick={() => setView('settings')} className={`flex flex-col items-center gap-1 flex-1 ${view === 'settings' ? 'text-cyan-400' : 'text-zinc-500'}`}>
            <Monitor className="w-6 h-6" />
            <span className="text-[10px] uppercase font-bold tracking-widest">Connect</span>
          </button>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col p-5 md:p-12 pb-32 md:pb-12 relative overflow-hidden">
          {/* Top Search Bar (Mobile Hidden on some views) */}
          <div className={`flex-shrink-0 mb-8 md:mb-12 ${view !== 'search' && view !== 'library' ? 'hidden md:flex' : ''}`}>
            <form onSubmit={handleSearch} className="flex items-center bg-zinc-900 border border-zinc-800 rounded-full px-5 py-3 md:px-6 md:py-4 max-w-2xl group focus-within:border-cyan-500/50 transition-all">
              <SearchIcon className="w-5 h-5 text-zinc-500 mr-3 md:mr-4 group-focus-within:text-cyan-500" />
              <input 
                type="text" 
                placeholder="Search songs..." 
                className="bg-transparent border-none outline-none text-base md:text-lg w-full placeholder-zinc-600 text-white"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setView('search')}
              />
            </form>
          </div>

          <div className="flex-1 overflow-y-auto">
            <AnimatePresence mode="wait">
              {view === 'library' ? (
                <motion.div 
                  key="library"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="mb-12">
                    <h1 className="text-7xl font-bold tracking-tight mb-4 leading-none">Listening <span className="text-cyan-500">Offline</span>.</h1>
                    <p className="text-zinc-500 text-xl max-w-xl">Your personal collection of premium streams, cached and ready for whenever you go off the grid.</p>
                  </div>

                  {library.length === 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                      <label className="group aspect-square bg-zinc-900/50 rounded-3xl flex flex-col items-center justify-center border-2 border-dashed border-zinc-800 cursor-pointer hover:border-cyan-500/50 transition-all">
                        <Plus className="w-12 h-12 text-zinc-700 group-hover:text-cyan-500" />
                        <span className="mt-4 font-bold text-zinc-600 group-hover:text-cyan-500">Import New</span>
                        <input type="file" multiple accept="audio/*" className="hidden" onChange={handleLocalFile} />
                      </label>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                      {library.map((song) => (
                        <SongCard 
                          key={song.id || `song-${Math.random()}`} 
                          song={song} 
                          isActive={currentSong?.id === song.id}
                          onPlay={() => playSong(song)}
                          onDelete={() => removeSong(song.id)}
                        />
                      ))}
                    </div>
                  )}
                </motion.div>
              ) : view === 'favorites' ? (
                <motion.div 
                  key="favorites"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="mb-12">
                    <h1 className="text-7xl font-bold tracking-tight mb-4 leading-none">Your <span className="text-pink-500">Favorites</span>.</h1>
                    <p className="text-zinc-500 text-xl max-w-xl">Synced across devices with your Google account.</p>
                  </div>

                  {!user ? (
                    <div className="p-12 text-center bg-zinc-900/50 rounded-3xl border border-zinc-800">
                      <p className="text-zinc-500 mb-6">Login to sync your favorite tracks</p>
                      <button onClick={loginWithGoogle} className="px-8 py-3 bg-white text-black rounded-full font-bold">Login Now</button>
                    </div>
                  ) : favorites.length === 0 ? (
                    <div className="p-12 text-center bg-zinc-900/50 rounded-3xl border border-zinc-800">
                      <p className="text-zinc-500">No favorites yet. Start searching!</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                      {favorites.map((fav) => (
                        <SongCard 
                          key={fav.id} 
                          song={{ ...fav, id: fav.songId, type: 'online' } as any} 
                          isActive={currentSong?.id === fav.songId}
                          onPlay={() => playSong({ ...fav, id: fav.songId, type: 'online' } as any)}
                          isFavorite={true}
                          onToggleFavorite={() => handleFavorite({ ...fav, id: fav.songId })}
                        />
                      ))}
                    </div>
                  )}
                </motion.div>
              ) : view === 'settings' ? (
                <motion.div 
                  key="settings"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="mb-12">
                    <h1 className="text-7xl font-bold tracking-tight mb-4 leading-none">YT <span className="text-red-500">Connect</span>.</h1>
                    <p className="text-zinc-500 text-xl max-w-xl">Bypass bot detection by connecting your real YouTube Music account.</p>
                  </div>

                  <div className="max-w-2xl bg-zinc-900/50 rounded-3xl p-8 border border-zinc-800">
                    <div className="flex items-center justify-between mb-8">
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${ytStatus.signedIn ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                          {ytStatus.signedIn ? <ShieldCheck className="w-6 h-6" /> : <WifiOff className="w-6 h-6" />}
                        </div>
                        <div>
                          <h2 className="font-bold text-xl">Status: {ytStatus.signedIn ? 'Authenticated' : 'Guest'}</h2>
                          <p className="text-zinc-500 text-sm">{ytStatus.signedIn ? 'Operating as an official mobile client' : 'Operating via anonymous proxy'}</p>
                        </div>
                      </div>
                      {ytStatus.signedIn && (
                        <button onClick={logoutYt} className="px-4 py-2 border border-zinc-800 rounded-lg text-sm hover:bg-zinc-800 transition-colors text-red-400">Disconnect</button>
                      )}
                    </div>

                    {!ytStatus.signedIn && !ytAuthData && (
                      <button 
                        onClick={startYtConnect}
                        disabled={isConnectingYt}
                        className="w-full py-4 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-3"
                      >
                        {isConnectingYt ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Monitor className="w-6 h-6" />}
                        Link YouTube Music Account
                      </button>
                    )}

                    {ytAuthData && (
                      <div className="mt-8 p-6 bg-black rounded-2xl border border-red-500/30 text-center animate-in fade-in slide-in-from-bottom-4">
                        <p className="text-zinc-400 mb-2">Step 1: Open this URL on your phone/PC</p>
                        <a 
                          href={ytAuthData.verification_url} 
                          target="_blank" 
                          rel="noreferrer"
                          className="text-cyan-400 font-bold mb-6 block text-lg underline flex items-center justify-center gap-2"
                        >
                          {ytAuthData.verification_url} <ExternalLink className="w-4 h-4" />
                        </a>
                        <p className="text-zinc-400 mb-2">Step 2: Enter this verification code</p>
                        <div className="text-5xl font-mono font-bold tracking-widest text-white py-6 bg-zinc-900 rounded-xl mb-4 border border-zinc-800">
                          {ytAuthData.user_code}
                        </div>
                        <div className="flex items-center justify-center gap-2 text-zinc-500 text-sm">
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Waiting for activation...
                        </div>
                      </div>
                    )}

                    <div className="mt-8 pt-8 border-t border-zinc-800">
                      <h3 className="text-zinc-400 text-sm font-medium mb-4 uppercase tracking-widest">Alternative Methods</h3>
                      <a 
                        href="https://music-six-steel.vercel.app/" 
                        target="_blank" 
                        rel="noreferrer"
                        className="flex items-center justify-between p-4 bg-zinc-900 rounded-xl border border-zinc-800 hover:border-zinc-700 transition-all group"
                      >
                        <div>
                          <p className="font-bold">Vercel Proxy Login</p>
                          <p className="text-zinc-500 text-xs text-balance">Use an external helper to generate session credentials if mobile auth fails.</p>
                        </div>
                        <ExternalLink className="w-5 h-5 text-zinc-600 group-hover:text-white transition-colors" />
                      </a>
                    </div>

                    <div className="mt-6 pt-6 border-t border-zinc-800">
                      <h3 className="text-zinc-400 text-sm font-medium mb-4 uppercase tracking-widest text-cyan-500">Search Resilience</h3>
                      <p className="text-zinc-500 text-xs mb-4">If search fails with "400 errors", provide a YouTube Data API v3 Key to enable the Tier 3 safety net.</p>
                      <div className="flex gap-2">
                        <input 
                          type="password" 
                          placeholder="Your YouTube API Key" 
                          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm focus:border-cyan-500 outline-none"
                          value={userApiKey}
                          onChange={(e) => setUserApiKey(e.target.value)}
                        />
                        <button 
                          onClick={async () => {
                            try {
                              await axios.post('/api/settings/api-key', { key: userApiKey });
                              alert('API Key Saved Successfully');
                            } catch (e) {
                              alert('Failed to save key');
                            }
                          }}
                          className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold transition-all"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div 
                  key="search"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <h1 className="text-7xl font-bold tracking-tight mb-12 leading-none">Search</h1>
                  {isSearching ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                      {[1, 2, 3, 4].map(i => (
                        <div key={`loader-${i}`} className="aspect-square bg-zinc-900 rounded-3xl animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                      {searchResults.map((item, idx) => (
                        <SearchCard 
                          key={item.id || `search-${idx}`} 
                          item={item} 
                          isActive={currentSong?.id === item.id}
                          isDownloading={downloadingIds.has(item.id)}
                          audioRef={audioRef}
                          onPlay={() => {
                            playSong({ ...item, type: 'online', dateAdded: Date.now() });
                          }}
                          onDownload={() => {
                            downloadSong(item.id, item.title, item.artist, item.thumbnail, item.duration);
                          }}
                          isSaved={library.some(s => s.id === item.id)}
                          isFavorite={favorites.some(f => f.songId === item.id)}
                          onToggleFavorite={() => handleFavorite(item)}
                        />
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>

      {/* Fixed Player / Fullscreen Player */}
      <AnimatePresence>
        {currentSong && (
          <>
            {/* Desktop / Mini Player Bar */}
            <motion.footer 
              initial={{ y: 112 }}
              animate={{ y: 0 }}
              exit={{ y: 112 }}
              onClick={() => {
                if (window.innerWidth < 768) setIsFullscreen(true);
              }}
              className="fixed bottom-20 md:bottom-0 left-0 right-0 h-20 md:h-28 bg-zinc-950/95 backdrop-blur-xl border-t border-zinc-800 px-4 md:px-8 flex items-center justify-between md:justify-start relative z-50 transition-all"
            >
              <div className="flex items-center gap-3 md:gap-4 w-full md:w-72">
                <div className="w-12 h-12 md:w-16 md:h-16 bg-zinc-800 rounded-xl overflow-hidden shadow-lg">
                  <img src={currentSong.thumbnail} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 overflow-hidden">
                  <h4 className="font-bold text-sm md:text-base truncate">{currentSong.title}</h4>
                  <p className="text-zinc-500 text-xs md:text-sm truncate">{currentSong.artist}</p>
                </div>
                <div className="flex items-center gap-3 md:hidden">
                  <button 
                    onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                    className="w-10 h-10 rounded-full bg-white flex items-center justify-center"
                  >
                    {isPlaying ? <Pause className="w-5 h-5 text-black fill-current" /> : <Play className="w-5 h-5 text-black fill-current ml-0.5" />}
                  </button>
                </div>
              </div>

              {/* Desktop Only Controls */}
              <div className="hidden md:flex flex-1 flex-col items-center max-w-xl mx-auto">
                <div className="flex items-center gap-10 mb-2">
                  <button onClick={playPrevious} className="text-zinc-500 hover:text-white transition-colors">
                    <SkipBack className="w-8 h-8 fill-current" />
                  </button>
                  <div className="relative">
                    <button 
                      onClick={togglePlay}
                      className={`w-12 h-12 rounded-full flex items-center justify-center hover:scale-105 transition-all shadow-xl ${playbackStatus === 'error' ? 'bg-red-500' : 'bg-white'}`}
                    >
                      {playbackStatus === 'loading' ? (
                        <div className="w-6 h-6 border-2 border-black border-t-transparent animate-spin rounded-full" />
                      ) : (
                        isPlaying ? <Pause className="w-6 h-6 text-black fill-current" /> : <Play className="w-6 h-6 text-black fill-current ml-1" />
                      )}
                    </button>
                  </div>
                  <button onClick={playNext} className="text-zinc-500 hover:text-white transition-colors">
                    <SkipForward className="w-8 h-8 fill-current" />
                  </button>
                </div>
                <div className="w-full flex items-center gap-3">
                  <span className="text-[10px] text-zinc-500 font-mono w-8">{formatTime(progress)}</span>
                  <div className="flex-1 h-1.5 bg-zinc-800 rounded-full relative group cursor-pointer" onClick={(e) => seek(e, duration)}>
                    <motion.div className="absolute h-full bg-cyan-500 rounded-full" style={{ width: `${(progress / duration) * 100 || 0}%` }} />
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono w-8">{formatTime(duration)}</span>
                </div>
              </div>

              {/* Desktop Only Utilities */}
              <div className="hidden md:w-72 md:flex justify-end items-center gap-6 text-zinc-400">
                {currentSong.type === 'online' && (
                  <button 
                    onClick={() => downloadSong(currentSong.id, currentSong.title, currentSong.artist, currentSong.thumbnail, currentSong.duration)}
                    className={`${downloadingIds.has(currentSong.id) ? 'animate-pulse text-cyan-400' : ''}`}
                  >
                    <DownloadCloud className="w-5 h-5" />
                  </button>
                )}
              </div>
            </motion.footer>

            {/* Mobile Fullscreen Player */}
            <AnimatePresence>
              {isFullscreen && (
                <motion.div 
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  exit={{ y: '100%' }}
                  transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                  className="fixed inset-0 bg-black z-[100] flex flex-col px-8 py-12"
                >
                  <div className="flex justify-between items-center mb-12">
                    <button onClick={() => setIsFullscreen(false)}><ChevronDown className="w-8 h-8 text-zinc-500" /></button>
                    <div className="text-center">
                      <p className="text-[10px] uppercase font-bold tracking-[0.2em] text-zinc-600">Now Playing</p>
                    </div>
                    <button onClick={() => { setIsFullscreen(false); setView('settings'); }}><Monitor className="w-6 h-6 text-zinc-500" /></button>
                  </div>

                  <div className="flex-1 flex flex-col items-center justify-center">
                    <motion.div 
                      layoutId={`art-${currentSong.id}`}
                      className="w-full aspect-square bg-zinc-900 rounded-[2.5rem] overflow-hidden shadow-2xl mb-12"
                    >
                      <img src={currentSong.thumbnail} alt="" className="w-full h-full object-cover" />
                    </motion.div>

                    <div className="w-full mb-8">
                      <h2 className="text-3xl font-bold mb-2">{currentSong.title}</h2>
                      <p className="text-xl text-zinc-500">{currentSong.artist}</p>
                    </div>

                    <div className="w-full space-y-8">
                      <div className="space-y-4">
                        <div className="flex justify-between text-xs text-zinc-500 font-mono">
                          <span>{formatTime(progress)}</span>
                          <span>{formatTime(duration)}</span>
                        </div>
                        <div 
                          className="h-1.5 bg-zinc-900 rounded-full relative"
                          onClick={(e) => seek(e, duration)}
                        >
                          <div 
                            className="absolute h-full bg-white rounded-full transition-all duration-300" 
                            style={{ width: `${(progress / duration) * 100 || 0}%` }} 
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <button className="text-zinc-600"><Heart className="w-7 h-7" /></button>
                        <div className="flex items-center gap-8">
                          <button onClick={playPrevious}><SkipBack className="w-10 h-10 fill-current" /></button>
                          <button 
                            onClick={togglePlay}
                            className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-xl"
                          >
                            {isPlaying ? <Pause className="w-8 h-8 text-black fill-current" /> : <Play className="w-8 h-8 text-black fill-current ml-1" />}
                          </button>
                          <button onClick={playNext}><SkipForward className="w-10 h-10 fill-current" /></button>
                        </div>
                        <button onClick={() => downloadSong(currentSong.id, currentSong.title, currentSong.artist, currentSong.thumbnail, currentSong.duration)} className={downloadingIds.has(currentSong.id) ? 'text-cyan-400' : 'text-zinc-600'}>
                          <DownloadCloud className="w-7 h-7" />
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Specific UI Components ---

interface SongCardProps {
  song: Song;
  isActive: boolean;
  onPlay: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
}

const SongCard: React.FC<SongCardProps> = ({ song, isActive, onPlay, onDelete, isFavorite, onToggleFavorite }) => {
  return (
    <div className="group relative" onClick={onPlay}>
      <div className="aspect-square bg-zinc-800 rounded-3xl mb-4 overflow-hidden relative border border-zinc-800 cursor-pointer shadow-2xl">
        <img src={song.thumbnail} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
        <div className="absolute bottom-4 left-4">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${song.type === 'offline' ? 'bg-cyan-500 text-black' : 'bg-zinc-700 text-white'}`}>
            {song.type === 'offline' ? 'Offline' : 'Cloud'}
          </span>
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40">
          <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center">
            {isActive ? <Pause className="w-8 h-8 text-black fill-current" /> : <Play className="w-8 h-8 text-black fill-current ml-1" />}
          </div>
        </div>
        <div className="absolute top-4 right-4 flex gap-2">
          {onToggleFavorite && (
            <button 
              onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
              className={`p-2 bg-black/50 rounded-xl transition-all opacity-0 group-hover:opacity-100 ${isFavorite ? 'text-pink-500 opacity-100' : 'text-white hover:text-pink-400'}`}
            >
              <Heart className={`w-5 h-5 ${isFavorite ? 'fill-current' : ''}`} />
            </button>
          )}
          {onDelete && (
            <button 
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-2 bg-black/50 rounded-xl text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
      <h3 className="font-bold text-lg truncate">{song.title}</h3>
      <p className="text-zinc-500 truncate">{song.artist}</p>
    </div>
  );
}

const SearchCard = ({ item, isActive, isDownloading, onPlay, onDownload, isSaved, isFavorite, onToggleFavorite }: any) => {
  return (
    <div className="group relative" onClick={onPlay}>
      <div className="aspect-square bg-zinc-800 rounded-3xl mb-4 overflow-hidden relative border border-zinc-800 cursor-pointer shadow-2xl">
        <img src={item.thumbnail} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
        <div className="absolute top-4 left-4">
          <span className="text-[10px] font-mono text-cyan-400 bg-black/50 px-2 py-1 rounded-md">{item.durationText}</span>
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40">
          <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center">
            {isActive ? <Pause className="w-8 h-8 text-black fill-current" /> : <Play className="w-8 h-8 text-black fill-current ml-1" />}
          </div>
        </div>
        <div className="absolute bottom-4 right-4 flex gap-2">
          <button 
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            className={`p-2 rounded-xl transition-all ${isFavorite ? 'bg-pink-500 text-white' : 'bg-black/50 text-white hover:bg-pink-500 hover:scale-110'}`}
          >
            <Heart className={`w-5 h-5 ${isFavorite ? 'fill-current' : ''}`} />
          </button>
          <button 
            onClick={(e) => { e.stopPropagation(); onDownload(); }}
            disabled={isDownloading || isSaved}
            className={`p-2 rounded-xl transition-all ${isSaved ? 'bg-cyan-500 text-black' : 'bg-black/50 text-white hover:bg-white hover:text-black'}`}
          >
            {isDownloading ? <div className="w-5 h-5 border-2 border-white border-t-transparent animate-spin rounded-full"></div> : (isSaved ? <DownloadCloud className="w-5 h-5" /> : <Plus className="w-5 h-5" />)}
          </button>
        </div>
      </div>
      <h3 className="font-bold text-lg truncate">{item.title}</h3>
      <p className="text-zinc-500 truncate">{item.artist}</p>
    </div>
  );
}
