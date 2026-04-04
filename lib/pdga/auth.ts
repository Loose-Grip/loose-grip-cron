import axios from 'axios';

export interface PdgaSession {
  sessid: string;
  session_name: string;
  token: string;
}

const PDGA_API_BASE = 'https://api.pdga.com/services/json';

export async function login(): Promise<PdgaSession> {
  const username = process.env.PDGA_USERNAME;
  const password = process.env.PDGA_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing PDGA_USERNAME or PDGA_PASSWORD environment variables');
  }

  const response = await axios.post<PdgaSession>(
    `${PDGA_API_BASE}/user/login`,
    { username, password },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const { sessid, session_name, token } = response.data;
  if (!sessid || !session_name || !token) {
    throw new Error('PDGA login response missing expected session fields');
  }

  return { sessid, session_name, token };
}

export async function logout(session: PdgaSession): Promise<void> {
  try {
    await axios.post(
      `${PDGA_API_BASE}/user/logout`,
      {},
      {
        headers: {
          'X-CSRF-Token': session.token,
          Cookie: `${session.session_name}=${session.sessid}`,
        },
      }
    );
  } catch (err) {
    // Best-effort logout; don't throw on cleanup failure
    console.warn('PDGA logout failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

export async function withSession<T>(fn: (session: PdgaSession) => Promise<T>): Promise<T> {
  const session = await login();
  try {
    return await fn(session);
  } catch (err) {
    // Re-authenticate once on 401/403 and retry
    if (axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) {
      console.warn('PDGA session expired mid-run; re-authenticating once…');
      const fresh = await login();
      try {
        return await fn(fresh);
      } finally {
        await logout(fresh);
      }
    }
    throw err;
  } finally {
    await logout(session);
  }
}
