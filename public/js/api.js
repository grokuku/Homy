/**
 * Minimal fetch client. Attaches the JWT, parses JSON, and emits an
 * `auth:expired` event on 401 so the app can return to the login view.
 */
export const api = {
  token: localStorage.getItem('hp_token') || null,

  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('hp_token', token);
    else localStorage.removeItem('hp_token');
  },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this._handle(res, path);
  },

  /**
   * Multipart upload (FormData). No explicit Content-Type: the browser sets
   * the multipart boundary itself.
   */
  async upload(path, formData) {
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(path, { method: 'POST', headers, body: formData });
    return this._handle(res, path);
  },

  // Never fire 'auth:expired' for the auth endpoints themselves — a failed
  // login (401) must not kick the user back to the login view from login.
  _authPath(path) {
    return (
      path === '/api/auth/login' ||
      path === '/api/auth/setup' ||
      path === '/api/auth/status'
    );
  },

  async _handle(res, path = '') {
    if (res.status === 401 && !this._authPath(path)) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }

    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  del(path) { return this.request('DELETE', path); },
};
