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
  Plus, Heart, Menu, X, ChevronDown, Music, WifiOff, Upload
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Song, getAllSongs, saveSong, deleteSong } from './db';
import axios from 'axios';
import { User } from 'firebase/auth';
import { loginWithGoogle, logout, subscribeToAuth, toggleFavorite, getFavorites, FavoriteSong } from './firebase';

// --- Components ---

type View = 'library' | 'search' | 'local' | 'favorites';

export default function App() {
  const [view, setView] = useState<View>('library');
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [library, setLibrary] = useState<Song[]>([]);
  const [favorites, setFavorites] = useState<FavoriteSong[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackStatus, setPlaybackStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackIdRef = useRef<number>(0);

  // Load library on mount
  useEffect(() => {
    refreshLibrary();
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
      alert('Search failed. Using fallback.');
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
      />

      {/* Main Container */}
      <div className="flex flex-1 overflow-hidden relative z-10">
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

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col p-12 relative overflow-hidden">
          {/* Top Search Bar */}
          <div className="flex-shrink-0 mb-12">
            <form onSubmit={handleSearch} className="flex items-center bg-zinc-900 border border-zinc-800 rounded-full px-6 py-4 max-w-2xl group focus-within:border-cyan-500/50 transition-all">
              <SearchIcon className="w-5 h-5 text-zinc-500 mr-4 group-focus-within:text-cyan-500" />
              <input 
                type="text" 
                placeholder="Search for songs, artists..." 
                className="bg-transparent border-none outline-none text-lg w-full placeholder-zinc-600 text-white"
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

      {/* Fixed Player Bar */}
      <AnimatePresence>
        {currentSong && (
          <motion.footer 
            initial={{ y: 112 }}
            animate={{ y: 0 }}
            exit={{ y: 112 }}
            className="h-28 bg-[#0D0D0D] border-t border-zinc-800 px-8 flex items-center relative z-50 transition-colors"
          >
            {/* Currently Playing */}
            <div className="flex items-center gap-4 w-72">
              <div className="w-16 h-16 bg-zinc-800 rounded-xl overflow-hidden shadow-lg">
                <img src={currentSong.thumbnail} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="overflow-hidden">
                <h4 className="font-bold truncate">{currentSong.title}</h4>
                <p className="text-zinc-500 text-sm truncate">{currentSong.artist}</p>
              </div>
              {currentSong.type === 'offline' && (
                <div className="text-cyan-500 ml-2">
                  <DownloadCloud className="w-5 h-5" />
                </div>
              )}
            </div>

            {/* Controls & Timeline */}
            <div className="flex-1 flex flex-col items-center max-w-xl mx-auto">
              <div className="flex items-center gap-10 mb-2">
                <button className="text-zinc-500 hover:text-white transition-colors">
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
                  {playbackStatus === 'error' && (
                    <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-red-500 font-bold">
                      Playback Error
                    </div>
                  )}
                </div>
                <button className="text-zinc-500 hover:text-white transition-colors">
                  <SkipForward className="w-8 h-8 fill-current" />
                </button>
              </div>
              <div className="w-full flex items-center gap-3">
                <span className="text-[10px] text-zinc-500 font-mono w-8">{formatTime(progress)}</span>
                <div 
                  className="flex-1 h-1.5 bg-zinc-800 rounded-full relative group cursor-pointer"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const pct = x / rect.width;
                    if (audioRef.current) audioRef.current.currentTime = pct * duration;
                  }}
                >
                  <motion.div 
                    className="absolute h-full bg-cyan-500 rounded-full"
                    style={{ width: `${(progress / duration) * 100 || 0}%` }}
                  />
                  <div 
                    className="absolute w-4 h-4 bg-white rounded-full -top-1.5 shadow-lg scale-0 group-hover:scale-100 transition-transform" 
                    style={{ left: `${(progress / duration) * 100 || 0}%`, transform: 'translateX(-50%)' }}
                  />
                </div>
                <span className="text-[10px] text-zinc-500 font-mono w-8">{formatTime(duration)}</span>
              </div>
            </div>

            {/* Utilities */}
            <div className="w-72 flex justify-end items-center gap-6 text-zinc-400">
              {currentSong.type === 'online' && (
                <button 
                  onClick={() => downloadSong(currentSong.id, currentSong.title, currentSong.artist, currentSong.thumbnail, currentSong.duration)}
                  className={`hover:text-cyan-400 transition-colors ${downloadingIds.has(currentSong.id) ? 'animate-pulse' : ''}`}
                >
                  <DownloadCloud className="w-5 h-5" />
                </button>
              )}
              <div className="flex items-center gap-2">
                <div className="w-24 h-1 bg-zinc-800 rounded-full overflow-hidden">
                  <div className="w-2/3 h-full bg-zinc-400"></div>
                </div>
              </div>
            </div>
          </motion.footer>
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
