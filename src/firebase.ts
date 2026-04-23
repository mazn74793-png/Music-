import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, addDoc, query, where, getDocs, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export interface FavoriteSong {
  id: string;
  userId: string;
  songId: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
  createdAt: any;
}

export const loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
};

export const logout = () => auth.signOut();

export const subscribeToAuth = (callback: (user: User | null) => void) => {
  return onAuthStateChanged(auth, callback);
};

// Firestore operations for Favorites
export const toggleFavorite = async (userId: string, song: any) => {
  const favoritesRef = collection(db, 'favorites');
  const q = query(favoritesRef, where('userId', '==', userId), where('songId', '==', song.id));
  const querySnapshot = await getDocs(q);

  if (!querySnapshot.empty) {
    // Unguarded delete for now, security rules will handle it
    const docId = querySnapshot.docs[0].id;
    await deleteDoc(doc(db, 'favorites', docId));
    return false; // Removed from favorites
  } else {
    await addDoc(favoritesRef, {
      userId,
      songId: song.id,
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail,
      duration: song.duration || 0,
      createdAt: serverTimestamp()
    });
    return true; // Added to favorites
  }
};

export const getFavorites = async (userId: string) => {
  const favoritesRef = collection(db, 'favorites');
  const q = query(favoritesRef, where('userId', '==', userId));
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
};
