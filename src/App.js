import { useState } from 'react';
import Auth from './components/Auth';
import Chat from './components/Chat';
import './App.css';

const getStoredUser = () => {
  const raw = localStorage.getItem('chatapp_user');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.username) return parsed;
  } catch {
    // Backward compatibility for older localStorage format (username string)
    return { username: raw, firstName: '', lastName: '', email: '' };
  }
  return null;
};

function App() {
  const [user, setUser] = useState(getStoredUser);

  const handleLogin = (userProfile) => {
    localStorage.setItem('chatapp_user', JSON.stringify(userProfile));
    setUser(userProfile);
  };

  const handleLogout = () => {
    localStorage.removeItem('chatapp_user');
    setUser(null);
  };

  if (user) {
    return <Chat username={user.username} userFirstName={user.firstName} onLogout={handleLogout} />;
  }
  return <Auth onLogin={handleLogin} />;
}

export default App;
