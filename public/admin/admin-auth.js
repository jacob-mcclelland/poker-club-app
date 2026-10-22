// Shared admin auth helper — imported by all admin sub-pages
import { db, auth } from '../firebase-api.js?v=6';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Call on page load. Hides #authGuard on success, returns {user, profile} or null.
export async function requireAdmin() {
  const guard    = document.getElementById('authGuard');
  const msg      = document.getElementById('authMsg');
  const loginBtn = document.getElementById('loginBtn');

  await auth.authStateReady();
  const user = auth.currentUser;

  if (!user) {
    msg.textContent = 'Sign in to continue';
    guard.querySelector('.spinner').style.display = 'none';
    if (loginBtn) loginBtn.style.display = 'inline-block';
    return null;
  }

  try {
    const snap    = await getDoc(doc(db, 'userProfiles', user.uid));
    const profile = snap.data() || {};
    if (profile.role === 'admin' || profile.isAdmin === true) {
      guard.style.display = 'none';
      return { user, profile };
    }
    msg.textContent = 'Access denied — admin role required';
    guard.querySelector('.spinner').style.display = 'none';
  } catch (e) {
    msg.textContent = 'Auth error: ' + e.message;
    guard.querySelector('.spinner').style.display = 'none';
  }
  return null;
}

export async function triggerLogin() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    location.reload();
  } catch (e) {
    alert('Sign in failed: ' + e.message);
  }
}
