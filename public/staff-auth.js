import {
  auth,
  db,
  doc,
  getDoc,
  GoogleAuthProvider,
  signInWithPopup
} from './firebase-api.js?v=6';

function ensureGuard() {
  let guard = document.getElementById('staffAuthGuard');
  if (guard) return guard;

  const style = document.createElement('style');
  style.textContent = `
    #staffAuthGuard {
      position: fixed;
      inset: 0;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(5,5,8,0.96);
      backdrop-filter: blur(10px);
    }
    .staff-auth-card {
      width: min(420px, 100%);
      background: #121418;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 18px;
      padding: 24px;
      color: #f8fafc;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .staff-auth-title {
      margin: 0 0 8px;
      font-size: 1.15rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #d4af37;
    }
    .staff-auth-msg {
      margin: 0;
      color: #cbd5e1;
      line-height: 1.5;
      font-size: 0.92rem;
    }
    .staff-auth-actions {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    .staff-auth-btn {
      border: none;
      border-radius: 10px;
      padding: 12px 16px;
      font-size: 0.92rem;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
    }
    .staff-auth-btn.primary {
      background: #ffffff;
      color: #111827;
    }
    .staff-auth-btn.secondary {
      background: rgba(255,255,255,0.08);
      color: #f8fafc;
      border: 1px solid rgba(255,255,255,0.1);
    }
  `;
  document.head.appendChild(style);

  guard = document.createElement('div');
  guard.id = 'staffAuthGuard';
  guard.innerHTML = `
    <div class="staff-auth-card">
      <div class="staff-auth-title">Staff Access</div>
      <p class="staff-auth-msg" id="staffAuthMessage">Verifying your staff session...</p>
      <div class="staff-auth-actions" id="staffAuthActions"></div>
    </div>
  `;
  document.body.appendChild(guard);
  return guard;
}

function setGuardState(message, actions = []) {
  const guard = ensureGuard();
  guard.querySelector('#staffAuthMessage').textContent = message;
  const actionsEl = guard.querySelector('#staffAuthActions');
  actionsEl.innerHTML = '';
  actions.forEach(({ label, variant = 'secondary', onClick }) => {
    const btn = document.createElement('button');
    btn.className = `staff-auth-btn ${variant}`;
    btn.textContent = label;
    btn.onclick = onClick;
    actionsEl.appendChild(btn);
  });
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function requireStaff() {
  ensureGuard();
  setGuardState('Verifying your staff session...');

  try {
    await withTimeout(auth.authStateReady(), 5000, 'Timed out restoring sign-in session.');
    const user = auth.currentUser;

    if (!user) {
      setGuardState('Sign in with your staff account to continue.', [
        {
          label: 'Sign In',
          variant: 'primary',
          onClick: async () => {
            try {
              await signInWithPopup(auth, new GoogleAuthProvider());
              location.reload();
            } catch (error) {
              setGuardState('Sign in failed. Try again or return to the player app.', [
                { label: 'Try Again', variant: 'primary', onClick: () => location.reload() },
                { label: 'Player App', onClick: () => { location.href = '/'; } }
              ]);
            }
          }
        },
        { label: 'Player App', onClick: () => { location.href = '/'; } }
      ]);
      throw new Error('auth-required');
    }

    const snap = await withTimeout(
      getDoc(doc(db, 'userProfiles', user.uid)),
      5000,
      'Timed out loading staff profile.'
    );
    const profile = snap.exists() ? snap.data() || {} : {};
    const isStaff = profile.role === 'staff' || profile.role === 'admin' || profile.isStaff === true || profile.isAdmin === true;

    if (!isStaff) {
      setGuardState('This account is not authorized for staff tools.', [
        { label: 'Player App', onClick: () => { location.href = '/'; } }
      ]);
      throw new Error('permission-denied');
    }

    document.getElementById('staffAuthGuard')?.remove();
    return { user, profile };
  } catch (error) {
    if (error.message === 'auth-required' || error.message === 'permission-denied') {
      throw error;
    }

    setGuardState(`${error.message} Use retry if staff access should already be available.`, [
      { label: 'Retry', variant: 'primary', onClick: () => location.reload() },
      { label: 'Player App', onClick: () => { location.href = '/'; } }
    ]);
    throw error;
  }
}
